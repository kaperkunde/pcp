import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto"
import type { Duplex } from "node:stream"

import { MAX_IDENTIFICATION_LINES, MAX_PACKET_BYTES } from "./limits"
import { SshFormatError, SshReader, SshWriter } from "./wire"

/**
 * The SSH transport layer (RFC 4253), cut down to one modern suite:
 * curve25519-sha256 for the key exchange, AES-GCM (RFC 5647, as OpenSSH
 * names it) for every packet after it, no compression. Both ends of it live
 * here so the test server (fake-server.ts) speaks exactly what the client
 * does; which host keys are acceptable is the client's (client.ts).
 *
 * The reader decodes one packet at a time, only when asked: the packet
 * after NEWKEYS is under the new keys, so nothing may be read ahead of it.
 */

export const MSG = {
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  KEX_ECDH_INIT: 30,
  KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50,
  USERAUTH_FAILURE: 51,
  USERAUTH_SUCCESS: 52,
  USERAUTH_BANNER: 53,
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
} as const

/** Reason codes for DISCONNECT. */
export const DISCONNECT = {
  PROTOCOL_ERROR: 2,
  KEY_EXCHANGE_FAILED: 3,
  HOST_KEY_NOT_VERIFIABLE: 9,
  BY_APPLICATION: 11,
  NO_MORE_AUTH_METHODS_AVAILABLE: 14,
} as const

/** The server ended the connection on purpose, saying why. */
export class SshDisconnectError extends Error {
  constructor(
    readonly reason: number,
    description: string,
  ) {
    super(description || `The server disconnected (reason ${reason}).`)
    this.name = "SshDisconnectError"
  }
}

/** The other end broke the protocol, or the connection went away. */
export class SshProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshProtocolError"
  }
}

export const KEX_ALGORITHMS = [
  "curve25519-sha256",
  "curve25519-sha256@libssh.org",
] as const
/** Strict key exchange (the Terrapin countermeasure), offered by each side. */
export const STRICT_KEX_CLIENT = "kex-strict-c-v00@openssh.com"
export const STRICT_KEX_SERVER = "kex-strict-s-v00@openssh.com"

export const CIPHERS = {
  "aes256-gcm@openssh.com": { keyLength: 32 },
  "aes128-gcm@openssh.com": { keyLength: 16 },
} as const
export type CipherName = keyof typeof CIPHERS
export const CIPHER_NAMES = Object.keys(CIPHERS) as CipherName[]

/**
 * MACs are not used with an AEAD cipher, and OpenSSH does not negotiate
 * them then; the list is sent because the message has a place for it.
 */
export const MAC_NAMES = ["hmac-sha2-256-etm@openssh.com", "hmac-sha2-256"]

const GCM_TAG = 16
const GCM_BLOCK = 16
const PLAIN_BLOCK = 8
const MIN_PADDING = 4

type Direction = {
  key: Buffer
  /** The 4 fixed bytes of the nonce. */
  fixed: Buffer
  /** The 8-byte invocation counter, bumped once per packet. */
  counter: bigint
  name: CipherName
}

function nonce(direction: Direction): Buffer {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(direction.counter, 0)
  direction.counter = BigInt.asUintN(64, direction.counter + 1n)
  return Buffer.concat([direction.fixed, counter])
}

function algorithmName(cipher: CipherName): "aes-256-gcm" | "aes-128-gcm" {
  return cipher === "aes256-gcm@openssh.com" ? "aes-256-gcm" : "aes-128-gcm"
}

/**
 * One SSH connection's packets, either end. `readIdentification` comes
 * first, then `next` and `send` for whole payloads.
 */
export class PacketStream {
  private buffer: Buffer = Buffer.alloc(0)
  private failure: Error | null = null
  private ended = false
  private wake: (() => void) | null = null
  private inbound: Direction | null = null
  private outbound: Direction | null = null

  constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer =
        this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.notify()
    })
    socket.on("error", (error: Error) => {
      this.failure ??= error
      this.notify()
    })
    socket.on("close", () => {
      this.ended = true
      this.notify()
    })
    socket.on("end", () => {
      this.ended = true
      this.notify()
    })
  }

  private notify() {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  /** Waits for more bytes; fails once the connection is gone. */
  private async more(): Promise<void> {
    if (this.failure) {
      throw this.failure
    }

    if (this.ended) {
      throw new SshProtocolError("The server closed the connection.")
    }

    await new Promise<void>((resolve) => {
      this.wake = resolve
    })

    if (this.failure) {
      throw this.failure
    }
  }

  /** Stops every read in progress with this error. */
  fail(error: Error): void {
    this.failure ??= error
    this.notify()
  }

  /**
   * The other side's identification string (without CR LF), skipping the
   * lines a server may send before it.
   */
  async readIdentification(): Promise<string> {
    for (let line = 0; line < MAX_IDENTIFICATION_LINES; line += 1) {
      let end = this.buffer.indexOf(0x0a)

      while (end < 0) {
        if (this.buffer.length > 255) {
          throw new SshProtocolError("The server's greeting is too long.")
        }

        await this.more()
        end = this.buffer.indexOf(0x0a)
      }

      if (end > 255) {
        throw new SshProtocolError("The server's greeting is too long.")
      }

      const text = this.buffer
        .subarray(0, end)
        .toString("latin1")
        .replace(/\r$/, "")
      this.buffer = this.buffer.subarray(end + 1)

      if (text.startsWith("SSH-")) {
        if (!text.startsWith("SSH-2.0-") && !text.startsWith("SSH-1.99-")) {
          throw new SshProtocolError(
            `The server speaks another version of SSH (${text.slice(0, 40)}).`,
          )
        }

        return text
      }
    }

    throw new SshProtocolError("The server did not say it speaks SSH.")
  }

  writeIdentification(line: string): void {
    this.socket.write(`${line}\r\n`)
  }

  private async bytes(count: number): Promise<void> {
    while (this.buffer.length < count) {
      await this.more()
    }
  }

  private takeBytes(count: number): Buffer {
    const part = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return part
  }

  /** The next packet's payload, its first byte the message number. */
  async next(): Promise<Buffer> {
    await this.bytes(4)
    const length = this.buffer.readUInt32BE(0)
    const block = this.inbound ? GCM_BLOCK : PLAIN_BLOCK
    const total = 4 + length + (this.inbound ? GCM_TAG : 0)

    if (
      length < 1 + MIN_PADDING ||
      length > MAX_PACKET_BYTES ||
      (this.inbound ? length : length + 4) % block !== 0
    ) {
      throw new SshProtocolError("The server sent a malformed packet.")
    }

    await this.bytes(total)
    const packet = this.takeBytes(total)
    let body: Buffer

    if (this.inbound) {
      const decipher = createDecipheriv(
        algorithmName(this.inbound.name),
        this.inbound.key,
        nonce(this.inbound),
        { authTagLength: GCM_TAG },
      )
      decipher.setAAD(packet.subarray(0, 4))
      decipher.setAuthTag(packet.subarray(4 + length))

      try {
        body = Buffer.concat([
          decipher.update(packet.subarray(4, 4 + length)),
          decipher.final(),
        ])
      } catch {
        throw new SshProtocolError(
          "A packet from the server failed its integrity check.",
        )
      }
    } else {
      body = packet.subarray(4)
    }

    const padding = body[0]!

    if (padding < MIN_PADDING || padding > length - 1) {
      throw new SshProtocolError("The server sent a malformed packet.")
    }

    const payload = body.subarray(1, length - padding)

    if (payload.length === 0) {
      throw new SshProtocolError("The server sent an empty packet.")
    }

    return Buffer.from(payload)
  }

  send(payload: Buffer): void {
    if (payload.length + 64 > MAX_PACKET_BYTES) {
      throw new SshProtocolError("A packet PCP was about to send is too long.")
    }

    const block = this.outbound ? GCM_BLOCK : PLAIN_BLOCK
    // The length field is outside the encryption with GCM, inside the
    // block count without it.
    const counted = this.outbound ? 1 + payload.length : 5 + payload.length
    let padding = block - (counted % block)
    if (padding < MIN_PADDING) {
      padding += block
    }

    const body = Buffer.concat([
      Buffer.from([padding]),
      payload,
      randomBytes(padding),
    ])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)

    if (!this.outbound) {
      this.socket.write(Buffer.concat([length, body]))
      return
    }

    const cipher = createCipheriv(
      algorithmName(this.outbound.name),
      this.outbound.key,
      nonce(this.outbound),
      { authTagLength: GCM_TAG },
    )
    cipher.setAAD(length)
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()])
    this.socket.write(Buffer.concat([length, encrypted, cipher.getAuthTag()]))
  }

  /** From the next packet sent on, under these keys. */
  encryptWith(name: CipherName, key: Buffer, iv: Buffer): void {
    this.outbound = direction(name, key, iv)
  }

  /** From the next packet read on, under these keys. */
  decryptWith(name: CipherName, key: Buffer, iv: Buffer): void {
    this.inbound = direction(name, key, iv)
  }

  /**
   * Ends the connection after what was sent, and drops it a moment later
   * if the other side does not close its half.
   */
  close(): void {
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 1000).unref()
  }
}

function direction(name: CipherName, key: Buffer, iv: Buffer): Direction {
  return {
    name,
    key: key.subarray(0, CIPHERS[name].keyLength),
    fixed: Buffer.from(iv.subarray(0, 4)),
    counter: iv.readBigUInt64BE(4),
  }
}

export type KexInit = {
  /** The whole message, byte 20 included: it goes into the exchange hash. */
  payload: Buffer
  kex: string[]
  hostKey: string[]
  cipherOut: string[]
  cipherIn: string[]
  firstFollows: boolean
}

export function writeKexInit({
  kex,
  hostKey,
  ciphers,
}: {
  kex: readonly string[]
  hostKey: readonly string[]
  ciphers: readonly string[]
}): Buffer {
  return new SshWriter()
    .byte(MSG.KEXINIT)
    .raw(randomBytes(16))
    .nameList(kex)
    .nameList(hostKey)
    .nameList(ciphers)
    .nameList(ciphers)
    .nameList(MAC_NAMES)
    .nameList(MAC_NAMES)
    .nameList(["none"])
    .nameList(["none"])
    .nameList([])
    .nameList([])
    .boolean(false)
    .uint32(0)
    .toBuffer()
}

/** `cipherOut` is client to server, `cipherIn` server to client. */
export function readKexInit(payload: Buffer): KexInit {
  const reader = new SshReader(payload)

  if (reader.byte() !== MSG.KEXINIT) {
    throw new SshProtocolError("The server did not start the key exchange.")
  }

  reader.uint32()
  reader.uint32()
  reader.uint32()
  reader.uint32()
  const kex = reader.nameList()
  const hostKey = reader.nameList()
  const cipherOut = reader.nameList()
  const cipherIn = reader.nameList()
  reader.nameList()
  reader.nameList()
  const compressionOut = reader.nameList()
  const compressionIn = reader.nameList()
  reader.nameList()
  reader.nameList()
  const firstFollows = reader.boolean()
  reader.uint32()

  if (!compressionOut.includes("none") || !compressionIn.includes("none")) {
    throw new SshProtocolError("The server insists on compression.")
  }

  return { payload, kex, hostKey, cipherOut, cipherIn, firstFollows }
}

/** The first of the client's names the server also has (RFC 4253, 7.1). */
export function choose(
  client: readonly string[],
  server: readonly string[],
  what: string,
): string {
  const found = client.find((name) => server.includes(name))

  if (!found) {
    throw new SshProtocolError(
      `The server offers no ${what} PCP uses (it offers ${server.join(", ") || "none"}).`,
    )
  }

  return found
}

/** An X25519 key pair for one key exchange, and its public half raw. */
export function ephemeralKey(): { privateKey: KeyObject; publicRaw: Buffer } {
  const pair = generateKeyPairSync("x25519")
  const { x } = pair.publicKey.export({ format: "jwk" }) as { x: string }
  return { privateKey: pair.privateKey, publicRaw: Buffer.from(x, "base64url") }
}

/** The shared secret, refusing a peer point that makes it all zeros. */
export function sharedSecret(privateKey: KeyObject, peerRaw: Buffer): Buffer {
  if (peerRaw.length !== 32) {
    throw new SshProtocolError("The key exchange value has the wrong length.")
  }

  let secret: Buffer

  try {
    secret = diffieHellman({
      privateKey,
      publicKey: createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: peerRaw.toString("base64url") },
        format: "jwk",
      }),
    })
  } catch {
    throw new SshProtocolError("The key exchange value is not valid.")
  }

  if (secret.every((byte) => byte === 0)) {
    throw new SshProtocolError("The key exchange value is not valid.")
  }

  return secret
}

/** H for curve25519-sha256 (RFC 8731, section 3). */
export function exchangeHash({
  clientId,
  serverId,
  clientKexInit,
  serverKexInit,
  hostKey,
  clientPublic,
  serverPublic,
  secret,
}: {
  clientId: string
  serverId: string
  clientKexInit: Buffer
  serverKexInit: Buffer
  hostKey: Buffer
  clientPublic: Buffer
  serverPublic: Buffer
  secret: Buffer
}): Buffer {
  return createHash("sha256")
    .update(
      new SshWriter()
        .string(Buffer.from(clientId, "latin1"))
        .string(Buffer.from(serverId, "latin1"))
        .string(clientKexInit)
        .string(serverKexInit)
        .string(hostKey)
        .string(clientPublic)
        .string(serverPublic)
        .mpint(secret)
        .toBuffer(),
    )
    .digest()
}

/** The keys both ends derive (RFC 4253, section 7.2), for GCM. */
export function deriveKeys(
  secret: Buffer,
  hash: Buffer,
  sessionId: Buffer,
): {
  clientIv: Buffer
  serverIv: Buffer
  clientKey: Buffer
  serverKey: Buffer
} {
  const k = new SshWriter().mpint(secret).toBuffer()
  const derive = (letter: string) =>
    createHash("sha256")
      .update(Buffer.concat([k, hash, Buffer.from(letter), sessionId]))
      .digest()

  // SHA-256 gives 32 bytes, enough for an AES-256 key and a 12-byte IV.
  return {
    clientIv: derive("A"),
    serverIv: derive("B"),
    clientKey: derive("C"),
    serverKey: derive("D"),
  }
}

export function disconnectPayload(reason: number, description: string) {
  return new SshWriter()
    .byte(MSG.DISCONNECT)
    .uint32(reason)
    .string(description)
    .string("")
    .toBuffer()
}

/** Reads a DISCONNECT into the error it stands for. */
export function readDisconnect(payload: Buffer): SshDisconnectError {
  try {
    const reader = new SshReader(payload)
    reader.byte()
    const reason = reader.uint32()
    const description = reader
      .string()
      .toString("utf8")
      .replace(/[^\x20-\x7e]/g, " ")
      .slice(0, 300)
    return new SshDisconnectError(reason, description)
  } catch (error) {
    if (error instanceof SshFormatError) {
      return new SshDisconnectError(0, "")
    }

    throw error
  }
}
