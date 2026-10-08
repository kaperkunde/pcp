import { connect as netConnect } from "node:net"
import type { Duplex } from "node:stream"

import { PCP_VERSION } from "../version"
import {
  certificateProblem,
  fingerprint,
  signEd25519,
  verifySignature,
  type OwnKey,
  type SshCertificate,
  type SshPublicKey,
  parseCertificateBlob,
} from "./keys"
import {
  CHANNEL_MAX_PACKET,
  CHANNEL_WINDOW,
  SSH_CONNECT_TIMEOUT_MS,
} from "./limits"
import {
  CIPHER_NAMES,
  DISCONNECT,
  KEX_ALGORITHMS,
  MSG,
  PacketStream,
  SshProtocolError,
  STRICT_KEX_CLIENT,
  STRICT_KEX_SERVER,
  choose,
  deriveKeys,
  disconnectPayload,
  ephemeralKey,
  exchangeHash,
  readDisconnect,
  readKexInit,
  sharedSecret,
  writeKexInit,
  type CipherName,
} from "./transport"
import { SshFormatError, SshReader, SshWriter } from "./wire"

/**
 * PCP's SSH client: one connection per call, signed in with a certificate
 * and nothing else, to a server that proves itself with a certificate and
 * nothing else.
 *
 * - The server's host key is accepted only as an OpenSSH host certificate
 *   (the key exchange offers no plain host key type at all), signed by one
 *   of the CAs the owner gave, valid now, naming the host PCP dialled, with
 *   no critical option PCP does not know. There is no trust on first use
 *   and no known_hosts: a server without such a certificate is refused.
 * - PCP signs in with publickey, offering only its user certificate (its
 *   own Ed25519 key, signed by the owner's CA). No password, no keyboard
 *   interaction, no bare key; a server that wants anything else is refused.
 * - It opens one session channel and runs one command with `exec`: no
 *   shell, no terminal, no forwarding of any kind, no agent.
 */

const CLIENT_ID = `SSH-2.0-PCP_${PCP_VERSION.replace(/[^A-Za-z0-9.]/g, "_")}`

/** Host key types offered, all certificates; with the signature each uses. */
const HOST_KEY_ALGORITHMS = {
  "ssh-ed25519-cert-v01@openssh.com": {
    certificate: "ssh-ed25519-cert-v01@openssh.com",
    signature: "ssh-ed25519",
  },
  "ecdsa-sha2-nistp256-cert-v01@openssh.com": {
    certificate: "ecdsa-sha2-nistp256-cert-v01@openssh.com",
    signature: "ecdsa-sha2-nistp256",
  },
  "ecdsa-sha2-nistp384-cert-v01@openssh.com": {
    certificate: "ecdsa-sha2-nistp384-cert-v01@openssh.com",
    signature: "ecdsa-sha2-nistp384",
  },
  "ecdsa-sha2-nistp521-cert-v01@openssh.com": {
    certificate: "ecdsa-sha2-nistp521-cert-v01@openssh.com",
    signature: "ecdsa-sha2-nistp521",
  },
  "rsa-sha2-512-cert-v01@openssh.com": {
    certificate: "ssh-rsa-cert-v01@openssh.com",
    signature: "rsa-sha2-512",
  },
  "rsa-sha2-256-cert-v01@openssh.com": {
    certificate: "ssh-rsa-cert-v01@openssh.com",
    signature: "rsa-sha2-256",
  },
} as const

export const HOST_CERTIFICATE_TYPES = Object.keys(HOST_KEY_ALGORITHMS)

/** Where to connect and whom to trust there. */
export type SshTarget = {
  host: string
  port: number
  username: string
  /** The CAs whose host certificates PCP accepts for this server. */
  hostAuthorities: SshPublicKey[]
}

/** PCP's key and the certificate the owner's CA made for it. */
export type SshIdentity = {
  key: OwnKey
  certificate: SshCertificate
}

/** The server's host certificate did not check out. */
export class SshHostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshHostError"
  }
}

/** The server turned down PCP's certificate, or it cannot be used. */
export class SshAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshAuthError"
  }
}

export class SshTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshTimeoutError"
  }
}

export type SshDeps = {
  connect: (host: string, port: number) => Duplex
  now: () => Date
}

export const defaultSshDeps: SshDeps = {
  connect: (host, port) => netConnect({ host, port }),
  now: () => new Date(),
}

/** What the host proved itself with, for the owner's page. */
export type HostProof = {
  keyId: string
  fingerprint: string
  authority: string
}

type Session = {
  stream: PacketStream
  host: HostProof
  /** The next message that is not transport upkeep. */
  message: () => Promise<Buffer>
  close: () => void
}

/** Why PCP's own certificate cannot be used for this login, if it cannot. */
export function identityProblem(
  identity: SshIdentity,
  username: string,
  now: Date,
): string | null {
  if (
    !identity.certificate.publicKey.blob.equals(identity.key.publicKey.blob)
  ) {
    return "The certificate is for another key than PCP's."
  }

  return certificateProblem(identity.certificate, {
    type: "user",
    principal: username,
    authorities: null,
    now,
  })
}

/** Transport messages handled the same way at every step. */
function upkeep(stream: PacketStream, payload: Buffer): boolean {
  switch (payload[0]) {
    case MSG.IGNORE:
    case MSG.DEBUG:
    case MSG.UNIMPLEMENTED:
    case MSG.EXT_INFO:
      return true
    case MSG.DISCONNECT:
      throw readDisconnect(payload)
    case MSG.KEXINIT:
      throw new SshProtocolError(
        "The server asked to exchange keys again, which PCP does not do within one command.",
      )
    case MSG.GLOBAL_REQUEST: {
      const reader = new SshReader(payload)
      reader.byte()
      reader.string()
      if (reader.boolean()) {
        stream.send(Buffer.from([MSG.REQUEST_FAILURE]))
      }
      return true
    }
    default:
      return false
  }
}

async function handshake(
  stream: PacketStream,
  target: SshTarget,
  now: Date,
): Promise<{ sessionId: Buffer; host: HostProof }> {
  stream.writeIdentification(CLIENT_ID)
  const serverId = await stream.readIdentification()

  const clientKexInit = writeKexInit({
    kex: [...KEX_ALGORITHMS, STRICT_KEX_CLIENT],
    hostKey: HOST_CERTIFICATE_TYPES,
    ciphers: CIPHER_NAMES,
  })
  stream.send(clientKexInit)

  // Strict or not, the key exchange is the first thing a server sends.
  const serverInit = readKexInit(await stream.next())
  const strict = serverInit.kex.includes(STRICT_KEX_SERVER)
  const kexMessage = async (): Promise<Buffer> => {
    for (;;) {
      const payload = await stream.next()

      if (payload[0] === MSG.DISCONNECT) {
        throw readDisconnect(payload)
      }

      // Without strict key exchange these may come in between; with it,
      // nothing may (CVE-2023-48795).
      if (!strict && (payload[0] === MSG.IGNORE || payload[0] === MSG.DEBUG)) {
        continue
      }

      return payload
    }
  }

  const kex = choose(KEX_ALGORITHMS, serverInit.kex, "key exchange")
  let hostAlgorithm: keyof typeof HOST_KEY_ALGORITHMS

  try {
    hostAlgorithm = choose(
      HOST_CERTIFICATE_TYPES,
      serverInit.hostKey,
      "host certificate",
    ) as keyof typeof HOST_KEY_ALGORITHMS
  } catch {
    throw new SshHostError(
      `${target.host} presents no host certificate, only plain host keys (${serverInit.hostKey.join(", ") || "none"}). PCP connects only to a server whose host key is certified by your CA.`,
    )
  }

  const cipherOut = choose(CIPHER_NAMES, serverInit.cipherOut, "cipher")
  const cipherIn = choose(CIPHER_NAMES, serverInit.cipherIn, "cipher")

  // A server that guessed our choices wrong sends a packet to be ignored.
  if (
    serverInit.firstFollows &&
    (serverInit.kex[0] !== kex || serverInit.hostKey[0] !== hostAlgorithm)
  ) {
    await kexMessage()
  }

  const ephemeral = ephemeralKey()
  stream.send(
    new SshWriter()
      .byte(MSG.KEX_ECDH_INIT)
      .string(ephemeral.publicRaw)
      .toBuffer(),
  )

  const reply = await kexMessage()
  if (reply[0] !== MSG.KEX_ECDH_REPLY) {
    throw new SshProtocolError("The server did not answer the key exchange.")
  }

  const reader = new SshReader(reply)
  reader.byte()
  const hostKeyBlob = reader.string()
  const serverPublic = reader.string()
  const signature = reader.string()
  reader.end()

  const expected = HOST_KEY_ALGORITHMS[hostAlgorithm]
  let certificate: SshCertificate

  try {
    certificate = parseCertificateBlob(hostKeyBlob)
  } catch (error) {
    throw new SshHostError(
      `${target.host}'s host certificate cannot be read: ${error instanceof Error ? error.message : "it is malformed"}`,
    )
  }

  if (certificate.type !== expected.certificate) {
    throw new SshHostError(
      `${target.host} sent a ${certificate.type} where it agreed to a ${expected.certificate}.`,
    )
  }

  const problem = certificateProblem(certificate, {
    type: "host",
    principal: target.host,
    authorities: target.hostAuthorities,
    now,
  })
  if (problem) {
    throw new SshHostError(
      `${target.host}'s host certificate is not accepted. ${problem}`,
    )
  }

  const secret = sharedSecret(ephemeral.privateKey, serverPublic)
  const hash = exchangeHash({
    clientId: CLIENT_ID,
    serverId,
    clientKexInit,
    serverKexInit: serverInit.payload,
    hostKey: hostKeyBlob,
    clientPublic: ephemeral.publicRaw,
    serverPublic,
    secret,
  })

  // Proves the server holds the private half of the certified key.
  if (
    !verifySignature(certificate.publicKey, signature, hash, expected.signature)
  ) {
    throw new SshHostError(
      `${target.host} could not prove it holds the key its certificate names.`,
    )
  }

  const keys = deriveKeys(secret, hash, hash)
  stream.send(Buffer.from([MSG.NEWKEYS]))
  stream.encryptWith(cipherOut as CipherName, keys.clientKey, keys.clientIv)

  const newKeys = await kexMessage()
  if (newKeys[0] !== MSG.NEWKEYS || newKeys.length !== 1) {
    throw new SshProtocolError("The server did not finish the key exchange.")
  }
  stream.decryptWith(cipherIn as CipherName, keys.serverKey, keys.serverIv)

  return {
    sessionId: hash,
    host: {
      keyId: certificate.keyId,
      fingerprint: fingerprint(certificate.publicKey),
      authority: fingerprint(certificate.signatureKey),
    },
  }
}

async function signIn(
  stream: PacketStream,
  target: SshTarget,
  identity: SshIdentity,
  sessionId: Buffer,
  message: () => Promise<Buffer>,
): Promise<void> {
  stream.send(
    new SshWriter().byte(MSG.SERVICE_REQUEST).string("ssh-userauth").toBuffer(),
  )

  const accepted = await message()
  if (accepted[0] !== MSG.SERVICE_ACCEPT) {
    throw new SshProtocolError("The server did not offer to sign PCP in.")
  }

  const algorithm = identity.certificate.type
  const signed = new SshWriter()
    .string(sessionId)
    .byte(MSG.USERAUTH_REQUEST)
    .string(target.username)
    .string("ssh-connection")
    .string("publickey")
    .boolean(true)
    .string(algorithm)
    .string(identity.certificate.blob)
    .toBuffer()

  stream.send(
    new SshWriter()
      .byte(MSG.USERAUTH_REQUEST)
      .string(target.username)
      .string("ssh-connection")
      .string("publickey")
      .boolean(true)
      .string(algorithm)
      .string(identity.certificate.blob)
      .string(signEd25519(identity.key.privateKey, signed))
      .toBuffer(),
  )

  for (;;) {
    const answer = await message()

    switch (answer[0]) {
      case MSG.USERAUTH_BANNER:
        continue
      case MSG.USERAUTH_SUCCESS:
        return
      case MSG.USERAUTH_FAILURE:
        throw new SshAuthError(
          `${target.host} turned down PCP's certificate for ${target.username}. Check that the server trusts your user CA (TrustedUserCAKeys) and that ${target.username} is one of the certificate's principals.`,
        )
      default:
        throw new SshProtocolError("The server answered the sign-in oddly.")
    }
  }
}

/**
 * Connects, checks the host, signs in. Fails within the connect timeout,
 * and on anything the server does that PCP does not expect.
 */
async function open(
  target: SshTarget,
  identity: SshIdentity,
  deps: SshDeps,
): Promise<Session> {
  const now = deps.now()
  const problem = identityProblem(identity, target.username, now)

  if (problem) {
    throw new SshAuthError(`PCP's certificate cannot be used. ${problem}`)
  }

  const socket = deps.connect(target.host, target.port)
  const stream = new PacketStream(socket)
  const timer = setTimeout(
    () =>
      stream.fail(
        new SshTimeoutError(
          `${target.host}:${target.port} did not finish signing PCP in within ${SSH_CONNECT_TIMEOUT_MS / 1000} seconds.`,
        ),
      ),
    SSH_CONNECT_TIMEOUT_MS,
  )
  const close = () => {
    clearTimeout(timer)

    try {
      stream.send(disconnectPayload(DISCONNECT.BY_APPLICATION, ""))
    } catch {
      // The connection is gone already.
    }

    stream.close()
  }
  const message = async (): Promise<Buffer> => {
    for (;;) {
      const payload = await stream.next()

      if (!upkeep(stream, payload)) {
        return payload
      }
    }
  }

  try {
    const { sessionId, host } = await handshake(stream, target, now)
    await signIn(stream, target, identity, sessionId, message)
    clearTimeout(timer)
    return { stream, host, message, close }
  } catch (error) {
    close()
    throw asSshError(error)
  }
}

function asSshError(error: unknown): unknown {
  if (error instanceof SshFormatError) {
    return new SshProtocolError(
      `The server sent something malformed: ${error.message}`,
    )
  }

  return error
}

/** Connects and signs in, then leaves: what the server's page checks. */
export async function sshCheck(
  target: SshTarget,
  identity: SshIdentity,
  deps: SshDeps = defaultSshDeps,
): Promise<HostProof> {
  const session = await open(target, identity, deps)
  session.close()
  return session.host
}

export type ExecOptions = {
  command: string
  stdin?: Buffer
  timeoutMs: number
  maxOutputBytes: number
}

export type ExecResult = {
  exitCode: number | null
  /** The signal that ended the command, without SIG. */
  signal: string | null
  stdout: Buffer
  stderr: Buffer
  /** It wrote more than PCP keeps, and was stopped. */
  truncated: boolean
  timedOut: boolean
}

/**
 * Runs one command and collects what it writes until it exits, writes too
 * much, or runs out of time. Either of the last two asks the server to end
 * it (a TERM signal request, which OpenSSH honours for every login but
 * root), closes the channel and the connection, and returns what it wrote
 * so far.
 */
export async function sshExec(
  target: SshTarget,
  identity: SshIdentity,
  options: ExecOptions,
  deps: SshDeps = defaultSshDeps,
): Promise<ExecResult> {
  const session = await open(target, identity, deps)
  const { stream, message } = session
  const result: ExecResult = {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    truncated: false,
    timedOut: false,
  }
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let collected = 0
  let remoteId: number | null = null

  const channelRequest = (name: string, extra?: (w: SshWriter) => void) => {
    if (remoteId === null) {
      return
    }

    const writer = new SshWriter()
      .byte(MSG.CHANNEL_REQUEST)
      .uint32(remoteId)
      .string(name)
      .boolean(false)
    extra?.(writer)
    stream.send(writer.toBuffer())
  }
  const stop = () => {
    try {
      channelRequest("signal", (w) => w.string("TERM"))
      if (remoteId !== null) {
        stream.send(
          new SshWriter().byte(MSG.CHANNEL_CLOSE).uint32(remoteId).toBuffer(),
        )
      }
    } catch {
      // Closing anyway.
    }
  }

  // From here on the command's own time runs: a server that never opens
  // the session is as stuck as a command that never ends.
  const timer = setTimeout(() => {
    result.timedOut = true
    stream.fail(new SshTimeoutError("timed out"))
  }, options.timeoutMs)

  try {
    stream.send(
      new SshWriter()
        .byte(MSG.CHANNEL_OPEN)
        .string("session")
        .uint32(0)
        .uint32(CHANNEL_WINDOW)
        .uint32(CHANNEL_MAX_PACKET)
        .toBuffer(),
    )

    const opened = await message()
    const reader = new SshReader(opened)
    const type = reader.byte()

    if (type === MSG.CHANNEL_OPEN_FAILURE) {
      reader.uint32()
      reader.uint32()
      throw new SshProtocolError(
        `${target.host} would not open a session: ${reader.text().slice(0, 200) || "no reason given"}.`,
      )
    }

    if (type !== MSG.CHANNEL_OPEN_CONFIRMATION || reader.uint32() !== 0) {
      throw new SshProtocolError("The server answered the session oddly.")
    }

    const channel = reader.uint32()
    remoteId = channel
    let remoteWindow = reader.uint32()
    const remoteMaxPacket = Math.min(reader.uint32(), CHANNEL_MAX_PACKET)
    let localWindow = CHANNEL_WINDOW

    stream.send(
      new SshWriter()
        .byte(MSG.CHANNEL_REQUEST)
        .uint32(channel)
        .string("exec")
        .boolean(true)
        .string(options.command)
        .toBuffer(),
    )

    let accepted = false
    let input = options.stdin ?? Buffer.alloc(0)
    let inputDone = false

    const feed = () => {
      while (!inputDone && remoteWindow > 0) {
        if (input.length === 0) {
          stream.send(
            new SshWriter().byte(MSG.CHANNEL_EOF).uint32(channel).toBuffer(),
          )
          inputDone = true
          return
        }

        const size = Math.min(input.length, remoteWindow, remoteMaxPacket)
        stream.send(
          new SshWriter()
            .byte(MSG.CHANNEL_DATA)
            .uint32(channel)
            .string(input.subarray(0, size))
            .toBuffer(),
        )
        input = input.subarray(size)
        remoteWindow -= size
      }

      // An empty remainder still owes the EOF, window or not.
      if (!inputDone && input.length === 0) {
        stream.send(
          new SshWriter().byte(MSG.CHANNEL_EOF).uint32(channel).toBuffer(),
        )
        inputDone = true
      }
    }

    const take = (into: Buffer[], data: Buffer) => {
      if (data.length > localWindow || data.length > CHANNEL_MAX_PACKET) {
        throw new SshProtocolError(
          "The server sent more than PCP made room for.",
        )
      }

      localWindow -= data.length
      const room = options.maxOutputBytes - collected
      into.push(data.subarray(0, Math.max(0, room)))
      collected += Math.min(data.length, Math.max(0, room))

      if (data.length > room) {
        result.truncated = true
        return
      }

      if (localWindow < CHANNEL_WINDOW / 2) {
        stream.send(
          new SshWriter()
            .byte(MSG.CHANNEL_WINDOW_ADJUST)
            .uint32(channel)
            .uint32(CHANNEL_WINDOW - localWindow)
            .toBuffer(),
        )
        localWindow = CHANNEL_WINDOW
      }
    }

    for (;;) {
      const payload = await message()
      const r = new SshReader(payload)
      const kind = r.byte()

      if (kind < MSG.CHANNEL_WINDOW_ADJUST || kind > MSG.CHANNEL_FAILURE) {
        throw new SshProtocolError(
          `The server sent message ${kind} mid-command.`,
        )
      }

      if (r.uint32() !== 0) {
        throw new SshProtocolError(
          "The server wrote to a channel PCP did not open.",
        )
      }

      if (kind === MSG.CHANNEL_SUCCESS && !accepted) {
        accepted = true
        feed()
      } else if (kind === MSG.CHANNEL_FAILURE && !accepted) {
        throw new SshProtocolError(`${target.host} refused to run the command.`)
      } else if (kind === MSG.CHANNEL_WINDOW_ADJUST) {
        remoteWindow = Math.min(remoteWindow + r.uint32(), 0xffffffff)
        if (accepted) {
          feed()
        }
      } else if (kind === MSG.CHANNEL_DATA) {
        take(stdout, r.string())
      } else if (kind === MSG.CHANNEL_EXTENDED_DATA) {
        const code = r.uint32()
        const data = r.string()
        // 1 is stderr; anything else is counted and dropped.
        take(code === 1 ? stderr : [], data)
      } else if (kind === MSG.CHANNEL_REQUEST) {
        const name = r.string().toString("latin1")
        const wantReply = r.boolean()

        if (name === "exit-status") {
          result.exitCode = r.uint32()
        } else if (name === "exit-signal") {
          result.signal = r.string().toString("latin1").slice(0, 40)
        } else if (wantReply) {
          stream.send(
            new SshWriter()
              .byte(MSG.CHANNEL_FAILURE)
              .uint32(channel)
              .toBuffer(),
          )
        }
      } else if (kind === MSG.CHANNEL_CLOSE) {
        stream.send(
          new SshWriter().byte(MSG.CHANNEL_CLOSE).uint32(channel).toBuffer(),
        )
        remoteId = null
        break
      }
      // CHANNEL_EOF: the exit status and the close follow.

      if (result.truncated) {
        stop()
        break
      }
    }
  } catch (error) {
    if (!result.timedOut) {
      throw asSshError(error)
    }

    stop()
  } finally {
    clearTimeout(timer)
    session.close()
  }

  result.stdout = Buffer.concat(stdout)
  result.stderr = Buffer.concat(stderr)
  return result
}
