import { timingSafeEqual } from "node:crypto"

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
}

export type FakeSsh = {
  port: number
  /** The host key, as PCP pins it (`type base64`). */
  hostKey: string
  /** Logins that got in, commands run and signals sent, in order. */
  logins: string[]
  commands: string[]
  signals: string[]
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
  const clients = new Set<Connection>()

  const server = new Server(
    {
      hostKeys: [hostPrivate],
      // ssh2's server answers a signal for a session that is running a
      // command with a refusal, and tells no listener; its debug log is the
      // one place that shows what the client sent.
      debug: (line: string) => {
        const sent = /CHANNEL_REQUEST \(r:\d+, signal: (\w+)\)/.exec(line)
        if (sent) {
          signals.push(sent[1]!.replace(/^SIG/, ""))
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
    close: async () => {
      for (const client of clients) {
        client.end()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
