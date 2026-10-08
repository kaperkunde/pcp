import { Client, type ClientChannel, type ConnectConfig } from "ssh2"

import { PCP_VERSION } from "../version"
import { hostKeyLine } from "./keys"
import { SSH_CONNECT_TIMEOUT_MS } from "./limits"

/**
 * PCP's SSH connections, through ssh2: one connection per call, signed in
 * with PCP's own key and nothing else, to a host whose key is the one PCP
 * pinned.
 *
 * - The host key is checked against the pin when there is one. Without
 *   one, the key the server shows is taken, but reported as seen only after
 *   the key exchange has finished: ssh2 asks hostVerifier before it checks
 *   the server's signature, so a key is worth keeping only once the
 *   `handshake` event says the server proved it holds it.
 * - Only publickey: no password, no keyboard-interactive, no agent.
 * - One session channel, one command with `exec`: no terminal, no
 *   forwarding of any kind, no file transfer.
 */

/** Modern algorithms only: ssh2's defaults still carry SHA-1 ones. */
const ALGORITHMS: ConnectConfig["algorithms"] = {
  kex: [
    "curve25519-sha256",
    "curve25519-sha256@libssh.org",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "diffie-hellman-group16-sha512",
    "diffie-hellman-group18-sha512",
    "diffie-hellman-group14-sha256",
  ],
  serverHostKey: [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
  ],
  cipher: [
    "chacha20-poly1305@openssh.com",
    "aes256-gcm@openssh.com",
    "aes128-gcm@openssh.com",
    "aes256-ctr",
    "aes192-ctr",
    "aes128-ctr",
  ],
  hmac: [
    "hmac-sha2-256-etm@openssh.com",
    "hmac-sha2-512-etm@openssh.com",
    "hmac-sha2-256",
    "hmac-sha2-512",
  ],
  compress: ["none"],
}

/** Where to connect, as whom, and the host key PCP pinned, if any. */
export type SshTarget = {
  host: string
  port: number
  username: string
  /** `type base64`; null until PCP first finished a key exchange there. */
  hostKey: string | null
}

/** PCP's private key for the server, in OpenSSH's format. */
export type SshIdentity = { privateKey: string }

/** The server showed another host key than the one PCP pinned. */
export class SshHostKeyError extends Error {
  constructor(
    message: string,
    /** The key it showed, `type base64`. */
    readonly shown: string,
  ) {
    super(message)
    this.name = "SshHostKeyError"
  }
}

/** The server turned PCP's key down. */
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

/**
 * What a connection learned about the host, whether or not signing in
 * worked: the key it proved it holds (null when the key exchange did not
 * finish).
 */
export type HostSeen = { hostKey: string | null }

type Session = { client: Client; seen: HostSeen }

/**
 * Connects and signs in. `onSeen` hears the host key once the key exchange
 * has finished, before signing in, so a key is pinned even when the login
 * is refused (the owner has not added PCP's key yet).
 */
async function open(
  target: SshTarget,
  identity: SshIdentity,
  onSeen: (seen: HostSeen) => Promise<void>,
): Promise<Session> {
  const client = new Client()
  const seen: HostSeen = { hostKey: null }
  let shown: string | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      client.on("handshake", () => {
        // The server has signed the exchange with the key it showed.
        seen.hostKey = shown
      })
      client.on("ready", () => resolve())
      client.on("error", (error: Error & { level?: string }) => {
        if (error.level === "client-authentication") {
          reject(
            new SshAuthError(
              `${target.host} turned down PCP's key for ${target.username}. Add PCP's key to ${target.username}'s ~/.ssh/authorized_keys on the server.`,
            ),
          )
        } else if (error.level === "client-timeout") {
          reject(
            new SshTimeoutError(
              `${target.host}:${target.port} did not finish signing PCP in within ${SSH_CONNECT_TIMEOUT_MS / 1000} seconds.`,
            ),
          )
        } else if (shown && target.hostKey && shown !== target.hostKey) {
          reject(
            new SshHostKeyError(
              `${target.host}'s host key is not the one PCP pinned the first time it connected. If the server's key was changed on purpose, forget the old one on its page in PCP; otherwise someone may be in the way.`,
              shown,
            ),
          )
        } else {
          reject(error)
        }
      })
      client.on("close", () =>
        reject(new Error(`${target.host} closed the connection.`)),
      )

      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: identity.privateKey,
        // Nothing but the key: no password, no keyboard, no agent.
        authHandler: ["publickey"],
        tryKeyboard: false,
        agentForward: false,
        algorithms: ALGORITHMS,
        readyTimeout: SSH_CONNECT_TIMEOUT_MS,
        ident: `PCP_${PCP_VERSION.replace(/[^A-Za-z0-9.]/g, "_")}`,
        hostVerifier: (key: Buffer) => {
          shown = hostKeyLine(key)
          return target.hostKey === null || shown === target.hostKey
        },
      })
    })
  } catch (error) {
    client.end()
    await onSeen(seen)
    throw error
  }

  await onSeen(seen)
  return { client, seen }
}

/** Connects and signs in, then leaves: what the server's page checks. */
export async function sshCheck(
  target: SshTarget,
  identity: SshIdentity,
  onSeen: (seen: HostSeen) => Promise<void>,
): Promise<void> {
  const { client } = await open(target, identity, onSeen)
  client.end()
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
  /** It wrote more than PCP keeps. */
  truncated: boolean
  timedOut: boolean
}

/**
 * Sends a signal to the command. ssh2's own `channel.signal()` does nothing
 * once the channel's writable side has ended, which it has as soon as
 * standard input is sent, so this goes to its protocol layer the way that
 * method would. The test server records the signals it gets
 * (client.test.ts), so an ssh2 that moves these fails a test rather than
 * leaving commands running.
 */
function signal(client: Client, channel: ClientChannel, name: string) {
  const protocol = (
    client as unknown as {
      _protocol?: { signal?: (id: number, name: string) => void }
    }
  )._protocol
  const outgoing = (
    channel as unknown as { outgoing?: { id?: number; state?: string } }
  ).outgoing

  try {
    if (
      typeof protocol?.signal === "function" &&
      typeof outgoing?.id === "number" &&
      // "eof" once standard input was sent; a signal is still the
      // channel's until it is closed.
      (outgoing.state === "open" || outgoing.state === "eof")
    ) {
      protocol.signal(outgoing.id, name)
    }
  } catch {
    // The connection is closing anyway.
  }
}

/**
 * Runs one command and collects what it writes until it exits, writes too
 * much, or runs out of time. Either of the last two asks the server to end
 * it (a TERM signal, which OpenSSH honours for every login but root),
 * closes the connection and returns what it wrote so far.
 */
export async function sshExec(
  target: SshTarget,
  identity: SshIdentity,
  options: ExecOptions,
  onSeen: (seen: HostSeen) => Promise<void>,
): Promise<ExecResult> {
  const { client } = await open(target, identity, onSeen)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let collected = 0
  const result: ExecResult = {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    truncated: false,
    timedOut: false,
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let channel: ClientChannel | null = null
      const stop = () => {
        if (channel) {
          signal(client, channel, "TERM")
        }
        resolve()
      }
      const timer = setTimeout(() => {
        result.timedOut = true
        stop()
      }, options.timeoutMs)
      const take = (into: Buffer[], data: Buffer) => {
        const room = options.maxOutputBytes - collected
        into.push(data.subarray(0, Math.max(0, room)))
        collected += Math.min(data.length, Math.max(0, room))

        if (data.length > room && !result.truncated) {
          result.truncated = true
          clearTimeout(timer)
          stop()
        }
      }

      client.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      client.on("close", () => {
        clearTimeout(timer)
        resolve()
      })

      client.exec(options.command, { pty: false }, (error, stream) => {
        if (error) {
          clearTimeout(timer)
          reject(
            new Error(
              `${target.host} would not run the command: ${error.message}`,
            ),
          )
          return
        }

        channel = stream
        stream.on("data", (data: Buffer) => take(stdout, data))
        stream.stderr.on("data", (data: Buffer) => take(stderr, data))
        stream.on("exit", (code: number | null, signal?: string) => {
          result.exitCode = typeof code === "number" ? code : null
          result.signal = signal
            ? String(signal).replace(/^SIG/, "").slice(0, 40)
            : null
        })
        stream.on("close", () => {
          clearTimeout(timer)
          resolve()
        })
        stream.end(options.stdin ?? Buffer.alloc(0))
      })
    })
  } finally {
    client.end()
  }

  result.stdout = Buffer.concat(stdout)
  result.stderr = Buffer.concat(stderr)
  return result
}
