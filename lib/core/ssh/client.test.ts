import { afterEach, describe, expect, it } from "vitest"

import {
  SshAuthError,
  SshHostKeyError,
  sshCheck,
  sshExec,
  type HostSeen,
  type SshTarget,
} from "./client"
import {
  makeHostKey,
  startFakeSsh,
  type FakeSsh,
  type FakeSshOptions,
} from "./fake-server"
import { generateOwnKey } from "./keys"

const own = generateOwnKey("pcp-test")
const identity = { privateKey: own.privateKey }

let server: FakeSsh | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

async function start(
  options: Partial<FakeSshOptions> = {},
  pinned: "none" | "right" | "wrong" = "none",
) {
  server = await startFakeSsh({
    authorizedKey: () => own.publicKey,
    run: (command, stdin) => ({
      stdout: `ran ${command} with ${stdin.length} bytes\n`,
      stderr: "a warning\n",
      exitCode: 3,
    }),
    ...options,
  })

  const other = await startFakeSsh({
    authorizedKey: () => null,
    run: () => ({}),
  })
  const wrongKey = other.hostKey
  await other.close()

  const target: SshTarget = {
    host: "127.0.0.1",
    port: server.port,
    username: "deploy",
    hostKey:
      pinned === "right"
        ? server.hostKey
        : pinned === "wrong"
          ? wrongKey
          : null,
  }
  return { server, target }
}

/** What a connection reported about the host, for the pin. */
function recorder() {
  const seen: HostSeen[] = []
  return {
    seen,
    onSeen: async (value: HostSeen) => {
      seen.push(value)
    },
  }
}

const run = { command: "uptime", timeoutMs: 5000, maxOutputBytes: 1 << 20 }

describe("sshExec", () => {
  it("runs a command and returns its output and exit code", async () => {
    const { server, target } = await start()
    const { seen, onSeen } = recorder()
    const result = await sshExec(target, identity, run, onSeen)

    expect(result.stdout.toString()).toBe("ran uptime with 0 bytes\n")
    expect(result.stderr.toString()).toBe("a warning\n")
    expect(result.exitCode).toBe(3)
    expect(result.truncated).toBe(false)
    expect(server.logins).toEqual(["deploy"])
    expect(server.commands).toEqual(["uptime"])
    // The host key, once the server proved it holds it.
    expect(seen).toEqual([{ hostKey: server.hostKey }])
  })

  it("sends standard input past the server's window", async () => {
    const { target } = await start()
    const result = await sshExec(
      target,
      identity,
      { ...run, command: "wc -c", stdin: Buffer.alloc(300_000, 1) },
      recorder().onSeen,
    )

    expect(result.stdout.toString()).toBe("ran wc -c with 300000 bytes\n")
  })

  it("reports the signal that ended a command", async () => {
    const { target } = await start({ run: () => ({ signal: "KILL" }) })
    const result = await sshExec(target, identity, run, recorder().onSeen)

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe("KILL")
  })

  it("stops collecting from a command that writes more than it may", async () => {
    const { target } = await start({ run: () => ({ flood: true }) })
    const result = await sshExec(
      target,
      identity,
      { ...run, maxOutputBytes: 100_000 },
      recorder().onSeen,
    )

    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBe(100_000)
    await expect.poll(() => server!.signals).toEqual(["TERM"])
  })

  it("stops waiting for a command that runs out of time", async () => {
    const { target } = await start({ run: () => ({ hang: true }) })
    const result = await sshExec(
      target,
      identity,
      { ...run, timeoutMs: 300 },
      recorder().onSeen,
    )

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    // Asked to end, not just left: standard input had been sent already.
    await expect.poll(() => server!.signals).toEqual(["TERM"])
  })
})

describe("the host key", () => {
  it("connects when the pinned key is the one the server shows", async () => {
    const { target } = await start({}, "right")

    await expect(
      sshCheck(target, identity, recorder().onSeen),
    ).resolves.toBeUndefined()
  })

  it("refuses a server that shows another key than the pinned one", async () => {
    const { server, target } = await start({}, "wrong")
    const { seen, onSeen } = recorder()

    await expect(sshCheck(target, identity, onSeen)).rejects.toThrow(
      SshHostKeyError,
    )
    expect(server.logins).toEqual([])
    // A key that did not match is never reported as one to pin.
    expect(seen).toEqual([{ hostKey: null }])
  })

  it("reports the host key even when the server turns PCP's key down", async () => {
    const { server, target } = await start({ authorizedKey: () => null })
    const { seen, onSeen } = recorder()

    await expect(sshCheck(target, identity, onSeen)).rejects.toThrow(
      SshAuthError,
    )
    expect(seen).toEqual([{ hostKey: server.hostKey }])
  })

  it("keeps a test server's own host key when given one", async () => {
    const hostKey = makeHostKey()
    const first = await startFakeSsh({
      hostKey,
      authorizedKey: () => null,
      run: () => ({}),
    })
    const shown = first.hostKey
    await first.close()

    const { server } = await start({ hostKey })
    expect(server.hostKey).toBe(shown)
  })
})

describe("signing in", () => {
  it("is refused for another login, or a key the server does not have", async () => {
    const { server, target } = await start()

    await expect(
      sshCheck({ ...target, username: "root" }, identity, recorder().onSeen),
    ).rejects.toThrow(/turned down PCP's key for root/)
    await expect(
      sshCheck(
        target,
        { privateKey: generateOwnKey("other").privateKey },
        recorder().onSeen,
      ),
    ).rejects.toThrow(SshAuthError)
    expect(server.logins).toEqual([])
  })

  it("fails on a port nothing listens on", async () => {
    const { server, target } = await start()
    await server.close()

    await expect(sshCheck(target, identity, recorder().onSeen)).rejects.toThrow(
      /ECONNREFUSED/,
    )
  })
})
