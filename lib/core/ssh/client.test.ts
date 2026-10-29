import net from "node:net"
import type { Duplex } from "node:stream"

import { afterEach, describe, expect, it } from "vitest"

import {
  closeAllSshConnections,
  ensureSshConnection,
  openChannel,
  SshForwardingRefusedError,
  SshNotConnectedError,
  SshUnpinnedError,
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
  closeAllSshConnections()
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

/** A server on loopback that answers each line with "echo: " and the line. */
async function echoServer(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const sockets = new Set<net.Socket>()
  const listener = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("data", (data) => socket.write(`echo: ${data.toString()}`))
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const { port } = listener.address() as net.AddressInfo

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        listener.close(() => resolve())
      }),
  }
}

function roundTrip(channel: Duplex, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    channel.once("data", (data: Buffer) => resolve(data.toString()))
    channel.once("error", reject)
    channel.write(text)
  })
}

describe("openChannel, for exits", () => {
  it("opens direct-tcpip channels on one long-lived connection", async () => {
    const echo = await echoServer()

    try {
      const { server, target } = await start(
        {
          allowForwarding: true,
          // The test names a public address; the server reaches loopback.
          connectTo: () => ({ host: "127.0.0.1", port: echo.port }),
        },
        "right",
      )

      const first = await openChannel(
        "srv",
        target,
        identity,
        "93.184.216.34",
        80,
      )
      expect(await roundTrip(first, "one")).toBe("echo: one")
      const second = await openChannel(
        "srv",
        target,
        identity,
        "93.184.216.34",
        80,
      )
      expect(await roundTrip(second, "two")).toBe("echo: two")

      expect(server.forwards).toEqual(["93.184.216.34:80", "93.184.216.34:80"])
      // One connection, signed in once, for both channels.
      expect(server.connections()).toBe(1)
      expect(server.logins).toEqual(["deploy"])
      first.destroy()
      second.destroy()
      // Never remote forwarding, a Unix socket, the agent, X11 or a terminal.
      expect(server.requests).toEqual([])
    } finally {
      await echo.close()
    }
  })

  it("says clearly when the server does not allow forwarding", async () => {
    const { server, target } = await start({ allowForwarding: false }, "right")

    await expect(
      openChannel("srv", target, identity, "93.184.216.34", 443),
    ).rejects.toThrow(SshForwardingRefusedError)
    await expect(
      openChannel("srv", target, identity, "93.184.216.34", 443),
    ).rejects.toThrow(/TCP forwarding is off for deploy/)
    expect(server.forwardsAsked()).toBe(2)
    expect(server.requests).toEqual([])
  })

  it("never connects to a host whose key the owner has not pinned", async () => {
    const { server, target } = await start({ allowForwarding: true }, "none")

    await expect(
      openChannel("srv", target, identity, "93.184.216.34", 443),
    ).rejects.toThrow(SshUnpinnedError)
    await expect(ensureSshConnection("srv", target, identity)).rejects.toThrow(
      SshUnpinnedError,
    )
    expect(server.connections()).toBe(0)
  })

  it("refuses a host that shows another key than the pinned one", async () => {
    const { server, target } = await start({ allowForwarding: true }, "wrong")

    await expect(
      openChannel("srv", target, identity, "93.184.216.34", 443),
    ).rejects.toThrow(SshHostKeyError)
    expect(server.logins).toEqual([])
  })

  it("opens nothing without a key when no connection is open", async () => {
    const echo = await echoServer()

    try {
      const { server, target } = await start(
        {
          allowForwarding: true,
          connectTo: () => ({ host: "127.0.0.1", port: echo.port }),
        },
        "right",
      )

      await expect(
        openChannel("srv", target, null, "93.184.216.34", 80),
      ).rejects.toThrow(SshNotConnectedError)
      expect(server.connections()).toBe(0)

      // Once a request opened it with the key, a dial without one uses it.
      await ensureSshConnection("srv", target, identity)
      const channel = await openChannel(
        "srv",
        target,
        null,
        "93.184.216.34",
        80,
      )
      expect(await roundTrip(channel, "x")).toBe("echo: x")
      channel.destroy()

      // A closed connection is not opened again without the key.
      closeAllSshConnections()
      await expect(
        openChannel("srv", target, null, "93.184.216.34", 80),
      ).rejects.toThrow(SshNotConnectedError)
    } finally {
      await echo.close()
    }
  })

  it("reports an address the server could not reach", async () => {
    const { target } = await start(
      { allowForwarding: true, connectTo: () => null },
      "right",
    )

    await expect(
      openChannel("srv", target, identity, "93.184.216.34", 81),
    ).rejects.toThrow(/could not connect to 93\.184\.216\.34:81/)
  })
})

describe("the test server's record of what a client asked for", () => {
  it("shows remote forwarding and a Unix socket, which PCP never asks for", async () => {
    const { Client } = await import("ssh2")
    const { server } = await start({}, "right")
    const client = new Client()

    await new Promise<void>((resolve, reject) => {
      client.on("ready", () => resolve())
      client.on("error", reject)
      client.connect({
        host: "127.0.0.1",
        port: server.port,
        username: "deploy",
        privateKey: own.privateKey,
      })
    })
    await new Promise<void>((resolve) =>
      client.forwardIn("127.0.0.1", 0, () => resolve()),
    )
    await new Promise<void>((resolve) =>
      client.openssh_forwardOutStreamLocal("/run/docker.sock", () => resolve()),
    )
    client.end()

    expect(server.requests).toEqual([
      "tcpip-forward",
      "channel:direct-streamlocal@openssh.com",
    ])
  })
})
