import { timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import net from "node:net"

import { Server, utils, type Connection, type SFTPWrapper } from "ssh2"

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
  /**
   * Answer the SFTP subsystem, on this machine's own file system with paths
   * as they are (a test hands PCP a folder under its temporary directory).
   * Off unless set: the server refuses the subsystem.
   */
  sftp?: boolean
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
  /** SFTP requests the server answered, by name ("OPEN /tmp/x/a"). */
  sftpRequests: string[]
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
  const sftpRequests: string[] = []
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
      // As OpenSSH's sshd: small packets go at once.
      ;(client as unknown as { setNoDelay(on: boolean): void }).setNoDelay(true)
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

          if (options.sftp) {
            session.on("sftp", (accept) => {
              serveSftp(accept(), sftpRequests)
            })
          }

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
    sftpRequests,
    connections: () => connections,
    close: async () => {
      for (const client of clients) {
        client.end()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ---- SFTP, for storage roots' tests ---------------------------------------

const { STATUS_CODE, OPEN_MODE } = utils.sftp

function statusOf(error: unknown): number {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
    ? STATUS_CODE.NO_SUCH_FILE
    : code === "EACCES" || code === "EPERM"
      ? STATUS_CODE.PERMISSION_DENIED
      : STATUS_CODE.FAILURE
}

function attrsOf(stat: fs.Stats) {
  return {
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  }
}

function openFlags(flags: number): number {
  const { constants } = fs
  const read = (flags & OPEN_MODE.READ) !== 0
  const write = (flags & OPEN_MODE.WRITE) !== 0
  let out =
    read && write
      ? constants.O_RDWR
      : write
        ? constants.O_WRONLY
        : constants.O_RDONLY
  if (flags & OPEN_MODE.APPEND) out |= constants.O_APPEND
  if (flags & OPEN_MODE.CREAT) out |= constants.O_CREAT
  if (flags & OPEN_MODE.TRUNC) out |= constants.O_TRUNC
  if (flags & OPEN_MODE.EXCL) out |= constants.O_EXCL
  return out
}

/**
 * An SFTP server over the local file system, as OpenSSH's sftp-server
 * behaves where PCP cares: RENAME fails when the new name is taken (it links
 * and unlinks), READDIR answers in batches and then EOF, an open with EXCL
 * fails on a name that is there. No extensions, so no posix-rename.
 */
function serveSftp(sftp: SFTPWrapper, log: string[]): void {
  const handles = new Map<
    string,
    { fd?: number; dir?: string[]; path: string }
  >()
  let next = 0
  const handle = (entry: { fd?: number; dir?: string[]; path: string }) => {
    const id = Buffer.from(String(next++))
    handles.set(id.toString(), entry)
    return id
  }
  const fail = (reqid: number, error: unknown) =>
    sftp.status(reqid, statusOf(error))
  const ok = (reqid: number) => sftp.status(reqid, STATUS_CODE.OK)

  sftp.on("REALPATH", (reqid, path) => {
    log.push(`REALPATH ${path}`)
    try {
      const real = fs.realpathSync(path === "" ? "." : path)
      sftp.name(reqid, [{ filename: real, longname: real, attrs: {} as never }])
    } catch (error) {
      fail(reqid, error)
    }
  })

  for (const [event, read] of [
    ["STAT", fs.statSync],
    ["LSTAT", fs.lstatSync],
  ] as const) {
    sftp.on(event, (reqid: number, path: string) => {
      log.push(`${event} ${path}`)
      try {
        sftp.attrs(reqid, attrsOf(read(path)))
      } catch (error) {
        fail(reqid, error)
      }
    })
  }

  sftp.on("OPENDIR", (reqid, path) => {
    log.push(`OPENDIR ${path}`)
    try {
      const names = fs.readdirSync(path)
      sftp.handle(reqid, handle({ dir: names, path }))
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftp.on("READDIR", (reqid, id) => {
    const entry = handles.get(id.toString())
    if (!entry?.dir) return sftp.status(reqid, STATUS_CODE.FAILURE)
    if (entry.dir.length === 0) return sftp.status(reqid, STATUS_CODE.EOF)
    // Small batches, so a reader's limit is tested across them.
    const batch = entry.dir.splice(0, 3)
    sftp.name(
      reqid,
      batch.map((name) => {
        const stat = fs.lstatSync(`${entry.path}/${name}`)
        return { filename: name, longname: name, attrs: attrsOf(stat) as never }
      }),
    )
  })

  sftp.on("OPEN", (reqid, filename, flags, attrs) => {
    log.push(`OPEN ${filename}`)
    try {
      const fd = fs.openSync(filename, openFlags(flags), attrs?.mode ?? 0o644)
      sftp.handle(reqid, handle({ fd, path: filename }))
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftp.on("READ", (reqid, id, offset, length) => {
    const entry = handles.get(id.toString())
    if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(entry.fd, buffer, 0, length, offset)
    if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.data(reqid, buffer.subarray(0, read))
  })

  sftp.on("WRITE", (reqid, id, offset, data) => {
    const entry = handles.get(id.toString())
    if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
    fs.writeSync(entry.fd, data, 0, data.length, offset)
    ok(reqid)
  })

  sftp.on("CLOSE", (reqid, id) => {
    const entry = handles.get(id.toString())
    handles.delete(id.toString())
    if (entry?.fd !== undefined) fs.closeSync(entry.fd)
    ok(reqid)
  })

  sftp.on("SETSTAT", (reqid, path, attrs) => {
    log.push(`SETSTAT ${path}`)
    try {
      if (typeof attrs.mode === "number")
        fs.chmodSync(path, attrs.mode & 0o7777)
      ok(reqid)
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftp.on("MKDIR", (reqid, path, attrs) => {
    log.push(`MKDIR ${path}`)
    try {
      fs.mkdirSync(path, { mode: attrs?.mode ?? 0o755 })
      ok(reqid)
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftp.on("RMDIR", (reqid, path) => {
    log.push(`RMDIR ${path}`)
    try {
      fs.rmdirSync(path)
      ok(reqid)
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftp.on("REMOVE", (reqid, path) => {
    log.push(`REMOVE ${path}`)
    try {
      fs.unlinkSync(path)
      ok(reqid)
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftp.on("RENAME", (reqid, from, to) => {
    log.push(`RENAME ${from} ${to}`)
    try {
      // As OpenSSH's sftp-server: never over a name that is taken.
      if (fs.existsSync(to) || isLink(to)) {
        return sftp.status(reqid, STATUS_CODE.FAILURE)
      }
      fs.renameSync(from, to)
      ok(reqid)
    } catch (error) {
      fail(reqid, error)
    }
  })
}

function isLink(path: string): boolean {
  try {
    return fs.lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
