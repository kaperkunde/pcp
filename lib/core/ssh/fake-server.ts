import { timingSafeEqual } from "node:crypto"
import net from "node:net"

import { Server, utils, type Connection } from "ssh2"

import { generateOwnKey, hostKeyLine } from "./keys"

/**
 * An SSH server for tests, on ssh2's own server: one login whose
 * authorized_keys is the key a test gives it, a function in place of a
 * shell, and knobs for a command that never ends or never stops writing.
 * Never used outside tests.
 */

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
  /** Writes until the client goes away. */
  | { flood: true }
  /** Never answers. */
  | { hang: true }

export type FakeSshOptions = {
  /** The login's authorized_keys: one public key line, or none yet. */
  authorizedKey: () => string | null
  login?: string
  /** The host's private key; a new one when left out. */
  hostKey?: string
  /** Where to listen; any free port when left out. */
  port?: number
  run: FakeRun
  /**
   * Whether direct-tcpip channels open (AllowTcpForwarding). Off unless
   * set: the server answers "administratively prohibited", as OpenSSH does.
   */
  allowForwarding?: boolean
  /**
   * Where a channel to `host`:`port` really goes, so a test can name a
   * public address and reach a server on loopback; as asked when left out.
   * Null refuses it as unreachable.
   */
  connectTo?: (
    host: string,
    port: number,
  ) => { host: string; port: number } | null
}

export type FakeSsh = {
  port: number
  /** The host key, as PCP pins it (`type base64`). */
  hostKey: string
  /** Logins that got in, commands run and signals sent, in order. */
  logins: string[]
  commands: string[]
  signals: string[]
  /** direct-tcpip channels the server opened, as host:port. */
  forwards: string[]
  /** direct-tcpip channels asked for, opened or refused. */
  forwardsAsked: () => number
  /**
   * Everything else a client asked for that PCP never should: global
   * requests (tcpip-forward, streamlocal-forward@openssh.com), streamlocal
   * channels, and session requests other than exec (auth-agent, x11, pty,
   * shell, subsystem).
   */
  requests: string[]
  /** Connections that signed in, counting each one once. */
  connections: () => number
  close: () => Promise<void>
}

/** A host key for a test server, in OpenSSH's private format. */
export function makeHostKey(): string {
  return generateOwnKey("test-host").privateKey
}

function publicBlob(privateOrPublic: string): Buffer {
  const parsed = utils.parseKey(privateOrPublic)
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new Error("The test server's key cannot be read.")
  }
  return parsed.getPublicSSH()
}

export async function startFakeSsh(options: FakeSshOptions): Promise<FakeSsh> {
  const login = options.login ?? "deploy"
  const hostPrivate = options.hostKey ?? makeHostKey()
  const logins: string[] = []
  const commands: string[] = []
  const signals: string[] = []
  const forwards: string[] = []
  const requests: string[] = []
  const clients = new Set<Connection>()
  let connections = 0
  let forwardsAsked = 0

  const server = new Server(
    {
      hostKeys: [hostPrivate],
      // ssh2's server answers a signal for a session that is running a
      // command with a refusal, and tells no listener; its debug log is the
      // one place that shows what the client sent.
      // It is also where every request a client made shows, refused or not.
      debug: (line: string) => {
        const sent = /CHANNEL_REQUEST \(r:\d+, signal: (\w+)\)/.exec(line)
        if (sent) {
          signals.push(sent[1]!.replace(/^SIG/, ""))
        }

        const global = /Inbound: GLOBAL_REQUEST \(([^)]+)\)/.exec(line)
        if (global && global[1] !== "keepalive@openssh.com") {
          requests.push(global[1]!)
        }

        const channel = /Inbound: CHANNEL_OPEN \(s:\d+, ([^)]+)\)/.exec(line)
        if (channel?.[1] === "direct-tcpip") {
          forwardsAsked++
        } else if (channel && channel[1] !== "session") {
          requests.push(`channel:${channel[1]}`)
        }

        const asked = /Inbound: CHANNEL_REQUEST \(r:\d+, ([^:)]+)/.exec(line)
        if (asked && asked[1] !== "exec" && asked[1] !== "signal") {
          requests.push(asked[1]!)
        }
      },
    },
    (client) => {
      clients.add(client)
      client.on("close", () => clients.delete(client))
      client.on("error", () => {})

      client.on("authentication", (context) => {
        const authorized = options.authorizedKey()

        if (
          context.method !== "publickey" ||
          context.username !== login ||
          !authorized
        ) {
          context.reject(["publickey"])
          return
        }

        const key = utils.parseKey(authorized)
        const allowed = publicBlob(authorized)

        if (
          key instanceof Error ||
          Array.isArray(key) ||
          context.key.data.length !== allowed.length ||
          !timingSafeEqual(context.key.data, allowed)
        ) {
          context.reject(["publickey"])
          return
        }

        // Without a signature the client is only asking whether the key would
        // do; with one, it has to verify.
        if (
          context.signature &&
          !key.verify(context.blob!, context.signature, context.hashAlgo)
        ) {
          context.reject(["publickey"])
          return
        }

        if (context.signature) {
          logins.push(context.username)
        }
        context.accept()
      })

      client.on("ready", () => {
        connections++

        // Without a listener, ssh2 answers a direct-tcpip channel with
        // "administratively prohibited", as OpenSSH does with forwarding off.
        if (options.allowForwarding) {
          client.on("tcpip", (accept, reject, info) => {
            forwards.push(`${info.destIP}:${info.destPort}`)

            const to = options.connectTo
              ? options.connectTo(info.destIP, info.destPort)
              : { host: info.destIP, port: info.destPort }

            if (!to) {
              reject()
              return
            }

            const upstream = net.connect(to.port, to.host)
            upstream.once("error", () => reject())
            upstream.once("connect", () => {
              const stream = accept()
              upstream.removeAllListeners("error")
              upstream.on("error", () => stream.destroy())
              stream.on("error", () => upstream.destroy())
              stream.pipe(upstream).pipe(stream)
            })
          })
        }

        client.on("session", (acceptSession) => {
          const session = acceptSession()

          session.on("exec", (accept, _reject, info) => {
            const stream = accept()
            commands.push(info.command)
            const input: Buffer[] = []
            let closed = false
            stream.on("close", () => {
              closed = true
            })
            stream.on("data", (data: Buffer) => input.push(data))
            stream.on("end", () => {
              const outcome = options.run(info.command, Buffer.concat(input))

              if ("hang" in outcome) {
                return
              }

              if ("flood" in outcome) {
                const chunk = Buffer.alloc(8 * 1024, 0x79)
                const pump = () => {
                  while (!closed && stream.write(chunk)) {
                    // Until the window is full.
                  }
                  if (!closed) {
                    stream.once("drain", pump)
                  }
                }
                pump()
                return
              }

              if (outcome.stdout) {
                stream.write(outcome.stdout)
              }
              if (outcome.stderr) {
                stream.stderr.write(outcome.stderr)
              }
              if (outcome.signal) {
                stream.exit(outcome.signal, false, "")
              } else {
                stream.exit(outcome.exitCode ?? 0)
              }
              stream.end()
            })
          })
        })
      })
    },
  )

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  )
  const address = server.address()

  return {
    port: typeof address === "object" && address ? address.port : 0,
    hostKey: hostKeyLine(publicBlob(hostPrivate)),
    logins,
    commands,
    signals,
    forwards,
    forwardsAsked: () => forwardsAsked,
    requests,
    connections: () => connections,
    close: async () => {
      for (const client of clients) {
        client.end()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
