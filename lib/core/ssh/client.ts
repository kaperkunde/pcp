import type { Duplex } from "node:stream"

import { Client, type ClientChannel, type ConnectConfig } from "ssh2"

import { PCP_VERSION } from "../version"
import { hostKeyLine } from "./keys"
import {
  SSH_CHANNEL_OPEN_TIMEOUT_MS,
  SSH_CONNECT_TIMEOUT_MS,
  SSH_EXIT_IDLE_MS,
  SSH_EXIT_MAX_CHANNELS,
  SSH_EXIT_MAX_CONNECTIONS,
  SSH_KEEPALIVE_COUNT,
  SSH_KEEPALIVE_INTERVAL_MS,
} from "./limits"

/**
 * PCP's SSH connections, through ssh2: one connection per call, signed in
 * with PCP's own key and nothing else, to a host whose key is the one PCP
 * pinned; and, for an exit (lib/core/exits/), one long-lived connection per
 * SSH server that carries direct-tcpip channels.
 *
 * - The host key is checked against the pin when there is one. Without
 *   one, the key the server shows is taken, but reported as seen only after
 *   the key exchange has finished: ssh2 asks hostVerifier before it checks
 *   the server's signature, so a key is worth keeping only once the
 *   `handshake` event says the server proved it holds it.
 * - Only publickey: no password, no keyboard-interactive, no agent.
 * - One session channel, one command with `exec`: no terminal, no file
 *   transfer.
 * - Forwarding for exits only, and only outbound: `openChannel` opens a
 *   direct-tcpip channel to an address and port the exits module checked
 *   from the exit's side (lib/core/exits/check.ts), or to the loopback port
 *   of an exit container PCP started itself. Never remote forwarding
 *   (tcpip-forward), never a Unix socket (streamlocal), never the agent or
 *   X11: a channel the server opens towards PCP is refused (ssh2 refuses
 *   every one PCP did not ask for, and PCP asks for none). A channel opens
 *   only on a host whose key the owner pinned, and a connection is made
 *   only with the key a request handed in (no reconnect in the background).
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
  extra: Partial<ConnectConfig> = {},
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
        ...extra,
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

// ---- Channels for exits ---------------------------------------------------

/** The server would not open the channel: forwarding is off for PCP's login. */
export class SshForwardingRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshForwardingRefusedError"
  }
}

/** The owner has not pinned the host's key: no channel opens there. */
export class SshUnpinnedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshUnpinnedError"
  }
}

/** No connection is open, and the caller had no key to make one with. */
export class SshNotConnectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshNotConnectedError"
  }
}

/** One long-lived connection that carries an exit's channels. */
type Pooled = {
  key: string
  client: Client
  /** The address the socket connected to: the exit's own, from its side too. */
  remoteAddress: string | null
  channels: number
  idleTimer: NodeJS.Timeout | null
  closed: boolean
}

type Pool = {
  open: Map<string, Pooled>
  /** Connections being made, so two calls at once make one. */
  opening: Map<string, Promise<Pooled>>
}

const POOL = Symbol.for("pcp.ssh.channels")

/**
 * Kept on globalThis: the gateway, the Server Actions and the browser's
 * proxy are bundled apart and would otherwise each hold a pool of their own.
 */
function pool(): Pool {
  const holder = globalThis as unknown as { [POOL]?: Pool }
  holder[POOL] ??= { open: new Map(), opening: new Map() }
  return holder[POOL]
}

/**
 * Which connection a channel goes on: the caller's name for it (the SSH
 * server's id) and everything that would make it another connection. A
 * changed address, login or pinned key is a new connection, never the old.
 */
function poolKey(name: string, target: SshTarget): string {
  return [
    name,
    target.host,
    target.port,
    target.username,
    target.hostKey ?? "",
  ].join("\n")
}

function closePooled(entry: Pooled): void {
  if (entry.closed) return
  entry.closed = true
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = null
  if (pool().open.get(entry.key) === entry) pool().open.delete(entry.key)
  entry.client.end()
}

/** Closes the connection once it has carried nothing for a while. */
function idleLater(entry: Pooled): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = null

  if (entry.channels === 0 && !entry.closed) {
    entry.idleTimer = setTimeout(() => closePooled(entry), SSH_EXIT_IDLE_MS)
    entry.idleTimer.unref()
  }
}

async function connectPooled(
  key: string,
  target: SshTarget,
  identity: SshIdentity,
): Promise<Pooled> {
  const state = pool()

  if (state.open.size + state.opening.size >= SSH_EXIT_MAX_CONNECTIONS) {
    throw new Error(
      `PCP already keeps ${SSH_EXIT_MAX_CONNECTIONS} exit connections open. Try again in a few minutes.`,
    )
  }

  // A call's connection never pins a key: the exit's host has one already.
  const { client } = await open(target, identity, async () => {}, {
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT,
  })
  const socket = (client as unknown as { _sock?: { remoteAddress?: string } })
    ._sock
  const entry: Pooled = {
    key,
    client,
    remoteAddress: socket?.remoteAddress ?? null,
    channels: 0,
    idleTimer: null,
    closed: false,
  }

  client.on("error", () => closePooled(entry))
  client.on("close", () => closePooled(entry))
  // ssh2 refuses every channel PCP did not ask for (it asks for none), and
  // hears no other request; these listeners only keep it that way.
  client.on("tcp connection", (_info, _accept, reject) => reject())
  client.on("unix connection", (_info, _accept, reject) => reject())
  client.on("x11", (_info, _accept, reject) => reject())
  idleLater(entry)
  return entry
}

/**
 * The connection for `name`, made with `identity` if none is open. Without
 * an identity only an open one is used: the browser's proxy dials between
 * requests, holding no key, and so never connects on its own.
 */
async function pooled(
  name: string,
  target: SshTarget,
  identity: SshIdentity | null,
): Promise<Pooled> {
  if (!target.hostKey) {
    throw new SshUnpinnedError(
      `PCP has not pinned ${target.host}'s host key yet, so it does not connect: the owner checks the server on its page first.`,
    )
  }

  const key = poolKey(name, target)
  const state = pool()
  const open = state.open.get(key)

  if (open && !open.closed) {
    return open
  }

  if (!identity) {
    throw new SshNotConnectedError(
      `PCP's connection to ${target.host} is closed. It opens again with the next call that uses the exit.`,
    )
  }

  let opening = state.opening.get(key)

  if (!opening) {
    opening = connectPooled(key, target, identity).then((entry) => {
      state.open.set(key, entry)
      return entry
    })
    state.opening.set(key, opening)
    void opening.finally(() => state.opening.delete(key)).catch(() => {})
  }

  return opening
}

/**
 * Makes sure the connection for `name` is open, with the key a request
 * handed in, and returns the address PCP connected to (the exit's own).
 */
export async function ensureSshConnection(
  name: string,
  target: SshTarget,
  identity: SshIdentity,
): Promise<{ remoteAddress: string | null }> {
  const entry = await pooled(name, target, identity)
  if (entry.channels === 0) idleLater(entry)
  return { remoteAddress: entry.remoteAddress }
}

/** The address an open connection for `name` went to; null if none is open. */
export function sshConnectionAddress(
  name: string,
  target: SshTarget,
): string | null {
  const entry = pool().open.get(poolKey(name, target))
  return entry && !entry.closed ? entry.remoteAddress : null
}

/** Closes every exit connection for `name` (an SSH server changed or went). */
export function closeSshConnections(name: string): void {
  for (const entry of [...pool().open.values()]) {
    if (entry.key.startsWith(`${name}\n`)) closePooled(entry)
  }
}

/** Every exit connection: at shutdown, a restore, or between tests. */
export function closeAllSshConnections(): void {
  for (const entry of [...pool().open.values()]) closePooled(entry)
}

/**
 * Opens a direct-tcpip channel from the SSH server to `host`:`port`, on the
 * long-lived connection for `name` (made with `identity` when none is open,
 * and only then). `host` is an address the exits module checked, never a
 * name an assistant gave. The channel is a Duplex: what is written goes to
 * the address, what it sends comes back.
 */
export async function openChannel(
  name: string,
  target: SshTarget,
  identity: SshIdentity | null,
  host: string,
  port: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Duplex> {
  signal?.throwIfAborted()
  const entry = await pooled(name, target, identity)

  if (entry.channels >= SSH_EXIT_MAX_CHANNELS) {
    throw new Error(
      `PCP already has ${SSH_EXIT_MAX_CHANNELS} connections open through ${target.host}. Try again in a moment.`,
    )
  }

  entry.channels++
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = null
  let counted = true
  const release = () => {
    if (!counted) return
    counted = false
    entry.channels = Math.max(0, entry.channels - 1)
    idleLater(entry)
  }

  try {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, stream?: ClientChannel) => {
        if (settled) {
          // Too late: the caller gave up or the time ran out.
          stream?.destroy()
          return
        }
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", aborted)
        if (error) reject(error)
        else resolve(stream!)
      }
      const aborted = () =>
        finish(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("aborted"),
        )
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `${target.host} did not open a connection to ${host}:${port} within ${SSH_CHANNEL_OPEN_TIMEOUT_MS / 1000} seconds.`,
            ),
          ),
        SSH_CHANNEL_OPEN_TIMEOUT_MS,
      )
      signal?.addEventListener("abort", aborted, { once: true })

      try {
        entry.client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
          if (!error) {
            finish(null, stream)
            return
          }

          const reason = (error as Error & { reason?: unknown }).reason
          finish(
            reason === 1
              ? new SshForwardingRefusedError(
                  `${target.host} does not let PCP open connections through it: TCP forwarding is off for ${target.username} (AllowTcpForwarding in its sshd_config, or restrict or no-port-forwarding on PCP's key in authorized_keys).`,
                )
              : new Error(
                  `${target.host} could not connect to ${host}:${port} (${error.message.replace(/^\(SSH\) Channel open failure:\s*/, "") || "refused"}).`,
                ),
          )
        })
      } catch (error) {
        // The connection closed under it.
        closePooled(entry)
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })

    channel.once("close", release)
    return channel
  } catch (error) {
    release()
    throw error
  }
}
