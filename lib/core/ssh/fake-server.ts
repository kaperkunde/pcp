import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto"
import { createServer, type Server, type Socket } from "node:net"

import {
  certificateProblem,
  parseCertificateBlob,
  parsePublicKeyBlob,
  signEd25519,
  verifySignature,
  type CertificateType,
  type SshCertificate,
  type SshPublicKey,
} from "./keys"
import {
  CIPHER_NAMES,
  DISCONNECT,
  MSG,
  PacketStream,
  STRICT_KEX_SERVER,
  choose,
  deriveKeys,
  disconnectPayload,
  ephemeralKey,
  exchangeHash,
  readKexInit,
  sharedSecret,
  writeKexInit,
  type CipherName,
} from "./transport"
import { SshReader, SshWriter } from "./wire"

/**
 * An SSH server for tests: the server half of transport.ts, a CA that
 * issues certificates, and knobs for each way a real server can go wrong.
 * It runs a function instead of a shell. Never used outside tests.
 */

export type TestCa = { privateKey: KeyObject; publicKey: SshPublicKey }

function ed25519Public(privateKey: KeyObject): SshPublicKey {
  const { x } = privateKey.export({ format: "jwk" }) as { x: string }
  return parsePublicKeyBlob(
    new SshWriter()
      .string("ssh-ed25519")
      .string(Buffer.from(x, "base64url"))
      .toBuffer(),
  )
}

export function makeEd25519(): TestCa {
  const { privateKey } = generateKeyPairSync("ed25519")
  return { privateKey, publicKey: ed25519Public(privateKey) }
}

function writeNames(names: string[]): Buffer {
  const writer = new SshWriter()
  for (const name of names) {
    writer.string(name)
  }
  return writer.toBuffer()
}

function writeOptions(options: Array<{ name: string; value?: string }>) {
  const writer = new SshWriter()
  for (const option of options) {
    writer
      .string(option.name)
      .string(
        option.value === undefined
          ? Buffer.alloc(0)
          : new SshWriter().string(option.value).toBuffer(),
      )
  }
  return writer.toBuffer()
}

/** An Ed25519 certificate for `key`, signed by `ca`. */
export function issueCertificate({
  ca,
  key,
  type,
  principals,
  keyId = "test",
  validAfter = 0n,
  validBefore = 0xffffffffffffffffn,
  criticalOptions = [],
  extensions = type === "user" ? ["permit-pty"] : [],
}: {
  ca: TestCa
  key: SshPublicKey
  type: CertificateType
  principals: string[]
  keyId?: string
  validAfter?: bigint
  validBefore?: bigint
  criticalOptions?: Array<{ name: string; value?: string }>
  extensions?: string[]
}): SshCertificate {
  if (key.type !== "ssh-ed25519") {
    throw new Error("The test CA certifies Ed25519 keys only.")
  }

  const point = new SshReader(key.blob)
  point.string()
  const signed = new SshWriter()
    .string("ssh-ed25519-cert-v01@openssh.com")
    .string(randomBytes(32))
    .string(point.string())
    .uint64(1n)
    .uint32(type === "user" ? 1 : 2)
    .string(keyId)
    .string(writeNames(principals))
    .uint64(validAfter)
    .uint64(validBefore)
    .string(writeOptions(criticalOptions))
    .string(writeOptions(extensions.map((name) => ({ name }))))
    .string("")
    .string(ca.publicKey.blob)
    .toBuffer()
  const signature = new SshWriter()
    .string("ssh-ed25519")
    .string(sign(null, signed, ca.privateKey))
    .toBuffer()

  return parseCertificateBlob(
    new SshWriter().raw(signed).string(signature).toBuffer(),
  )
}

/** What the server does with a command. */
export type FakeRun = (
  command: string,
  stdin: Buffer,
) =>
  | {
      stdout?: string | Buffer
      stderr?: string | Buffer
      exitCode?: number
      signal?: string
    }
  /** Writes forever, until the client closes the channel. */
  | { flood: true }
  /** Never answers. */
  | { hang: true }

export type FakeSshOptions = {
  hostKey?: TestCa
  /** The host certificate to present; null presents the plain key. */
  hostCertificate: SshCertificate | null
  /** Signs the key exchange with another key than the certified one. */
  wrongHostSignature?: boolean
  /** The CA whose user certificates the server accepts. */
  userAuthority: SshPublicKey
  run: FakeRun
  /** Offer strict key exchange; on unless a test turns it off. */
  strict?: boolean
  /** Signs in, then never answers the request for a session. */
  stallSession?: boolean
}

export type FakeSsh = {
  port: number
  /** Logins that got in, and commands run, in order. */
  logins: string[]
  commands: string[]
  close: () => Promise<void>
}

export async function startFakeSsh(options: FakeSshOptions): Promise<FakeSsh> {
  const sockets = new Set<Socket>()
  const state = { logins: [] as string[], commands: [] as string[] }
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    serve(socket, options, state).catch(() => socket.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()

  return {
    port: typeof address === "object" && address ? address.port : 0,
    logins: state.logins,
    commands: state.commands,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const SERVER_ID = "SSH-2.0-FakeSSH_1.0"

async function serve(
  socket: Socket,
  options: FakeSshOptions,
  state: { logins: string[]; commands: string[] },
): Promise<void> {
  const stream = new PacketStream(socket)
  const hostKey = options.hostKey ?? makeEd25519()
  const hostBlob = options.hostCertificate?.blob ?? hostKey.publicKey.blob
  const hostType = options.hostCertificate?.type ?? "ssh-ed25519"

  stream.writeIdentification(SERVER_ID)
  const clientId = await stream.readIdentification()
  const serverKexInit = writeKexInit({
    kex: [
      "curve25519-sha256",
      ...(options.strict === false ? [] : [STRICT_KEX_SERVER]),
    ],
    hostKey: [hostType],
    ciphers: CIPHER_NAMES,
  })
  stream.send(serverKexInit)
  const client = readKexInit(await stream.next())

  try {
    choose(client.hostKey, [hostType], "host key")
  } catch {
    stream.send(disconnectPayload(DISCONNECT.KEY_EXCHANGE_FAILED, "no match"))
    stream.close()
    return
  }

  const cipherIn = choose(client.cipherOut, CIPHER_NAMES, "cipher")
  const cipherOut = choose(client.cipherIn, CIPHER_NAMES, "cipher")
  const init = new SshReader(await stream.next())
  if (init.byte() !== MSG.KEX_ECDH_INIT) {
    throw new Error("expected ECDH_INIT")
  }
  const clientPublic = init.string()
  const ephemeral = ephemeralKey()
  const secret = sharedSecret(ephemeral.privateKey, clientPublic)
  const hash = exchangeHash({
    clientId,
    serverId: SERVER_ID,
    clientKexInit: client.payload,
    serverKexInit,
    hostKey: hostBlob,
    clientPublic,
    serverPublic: ephemeral.publicRaw,
    secret,
  })
  const signer = options.wrongHostSignature ? makeEd25519() : hostKey
  stream.send(
    new SshWriter()
      .byte(MSG.KEX_ECDH_REPLY)
      .string(hostBlob)
      .string(ephemeral.publicRaw)
      .string(signEd25519(signer.privateKey, hash))
      .toBuffer(),
  )

  const keys = deriveKeys(secret, hash, hash)
  stream.send(Buffer.from([MSG.NEWKEYS]))
  stream.encryptWith(cipherOut as CipherName, keys.serverKey, keys.serverIv)
  if ((await stream.next())[0] !== MSG.NEWKEYS) {
    throw new Error("expected NEWKEYS")
  }
  stream.decryptWith(cipherIn as CipherName, keys.clientKey, keys.clientIv)

  if ((await stream.next())[0] !== MSG.SERVICE_REQUEST) {
    throw new Error("expected SERVICE_REQUEST")
  }
  stream.send(
    new SshWriter().byte(MSG.SERVICE_ACCEPT).string("ssh-userauth").toBuffer(),
  )

  // Sign-in: a user certificate from the user CA, for the login, signed.
  const auth = new SshReader(await stream.next())
  auth.byte()
  const user = auth.text()
  auth.string()
  const method = auth.string().toString("latin1")
  let ok = false

  if (method === "publickey" && auth.boolean()) {
    const algorithm = auth.string().toString("latin1")
    const blob = auth.string()
    const signature = auth.string()
    const signed = new SshWriter()
      .string(hash)
      .byte(MSG.USERAUTH_REQUEST)
      .string(user)
      .string("ssh-connection")
      .string("publickey")
      .boolean(true)
      .string(algorithm)
      .string(blob)
      .toBuffer()

    try {
      const certificate = parseCertificateBlob(blob)
      ok =
        certificate.type === algorithm &&
        certificateProblem(certificate, {
          type: "user",
          principal: user,
          authorities: [options.userAuthority],
        }) === null &&
        verifySignature(certificate.publicKey, signature, signed)
    } catch {
      ok = false
    }
  }

  if (!ok) {
    stream.send(
      new SshWriter()
        .byte(MSG.USERAUTH_FAILURE)
        .nameList(["publickey"])
        .boolean(false)
        .toBuffer(),
    )
    await stream.next().catch(() => {})
    return
  }

  state.logins.push(user)
  stream.send(Buffer.from([MSG.USERAUTH_SUCCESS]))
  // Real servers send these; the client must cope.
  stream.send(
    new SshWriter()
      .byte(MSG.GLOBAL_REQUEST)
      .string("hostkeys-00@openssh.com")
      .boolean(false)
      .toBuffer(),
  )

  const open = new SshReader(await stream.next())
  if (options.stallSession) {
    await stream.next().catch(() => {})
    return
  }
  if (open.byte() !== MSG.CHANNEL_OPEN) {
    throw new Error("expected CHANNEL_OPEN")
  }
  open.string()
  const peer = open.uint32()
  let window = open.uint32()
  const maxPacket = open.uint32()
  const ours = 7
  stream.send(
    new SshWriter()
      .byte(MSG.CHANNEL_OPEN_CONFIRMATION)
      .uint32(peer)
      .uint32(ours)
      .uint32(64 * 1024)
      .uint32(16 * 1024)
      .toBuffer(),
  )

  const exec = new SshReader(await stream.next())
  exec.byte()
  exec.uint32()
  if (exec.string().toString("latin1") !== "exec") {
    throw new Error("expected exec")
  }
  exec.boolean()
  const command = exec.text()
  state.commands.push(command)
  stream.send(new SshWriter().byte(MSG.CHANNEL_SUCCESS).uint32(peer).toBuffer())

  let closed = false
  const input: Buffer[] = []
  let inputWindow = 64 * 1024

  const handle = (payload: Buffer) => {
    const reader = new SshReader(payload)
    const type = reader.byte()
    if (type === MSG.CHANNEL_WINDOW_ADJUST) {
      reader.uint32()
      window += reader.uint32()
    } else if (type === MSG.CHANNEL_DATA) {
      reader.uint32()
      const data = reader.string()
      input.push(data)
      inputWindow -= data.length
      if (inputWindow < 32 * 1024) {
        stream.send(
          new SshWriter()
            .byte(MSG.CHANNEL_WINDOW_ADJUST)
            .uint32(peer)
            .uint32(64 * 1024 - inputWindow)
            .toBuffer(),
        )
        inputWindow = 64 * 1024
      }
    } else if (type === MSG.CHANNEL_CLOSE || type === MSG.DISCONNECT) {
      closed = true
    }
    return type
  }

  // Standard input, up to its EOF.
  for (;;) {
    const type = handle(await stream.next())
    if (type === MSG.CHANNEL_EOF || closed) {
      break
    }
  }

  const outcome = options.run(command, Buffer.concat(input))

  if ("hang" in outcome) {
    await stream.next().catch(() => {})
    return
  }

  const write = async (data: Buffer, code: number | null) => {
    let rest = data
    while (rest.length > 0 && !closed) {
      while (window === 0 && !closed) {
        handle(await stream.next())
      }
      const size = Math.min(rest.length, window, maxPacket, 16 * 1024)
      const writer = new SshWriter()
        .byte(code === null ? MSG.CHANNEL_DATA : MSG.CHANNEL_EXTENDED_DATA)
        .uint32(peer)
      if (code !== null) {
        writer.uint32(code)
      }
      stream.send(writer.string(rest.subarray(0, size)).toBuffer())
      rest = rest.subarray(size)
      window -= size
    }
  }

  if ("flood" in outcome) {
    while (!closed) {
      await write(Buffer.alloc(8 * 1024, 0x79), null)
    }
    return
  }

  const bytes = (value: string | Buffer | undefined) =>
    typeof value === "string" ? Buffer.from(value) : (value ?? Buffer.alloc(0))
  await write(bytes(outcome.stdout), null)
  await write(bytes(outcome.stderr), 1)

  const request = (name: string, fill: (writer: SshWriter) => void) => {
    const writer = new SshWriter()
      .byte(MSG.CHANNEL_REQUEST)
      .uint32(peer)
      .string(name)
      .boolean(false)
    fill(writer)
    stream.send(writer.toBuffer())
  }

  if (outcome.signal) {
    request("exit-signal", (writer) =>
      writer.string(outcome.signal!).boolean(false).string("").string(""),
    )
  } else {
    request("exit-status", (writer) => writer.uint32(outcome.exitCode ?? 0))
  }

  stream.send(new SshWriter().byte(MSG.CHANNEL_EOF).uint32(peer).toBuffer())
  stream.send(new SshWriter().byte(MSG.CHANNEL_CLOSE).uint32(peer).toBuffer())

  while (!closed) {
    handle(await stream.next())
  }
}
