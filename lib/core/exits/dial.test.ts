import http from "node:http"
import net from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import {
  closeAllSshConnections,
  ensureSshConnection,
  openChannel,
  type SshTarget,
} from "../ssh/client"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { generateOwnKey } from "../ssh/keys"
import { ExitAddressError, makeExitDialer, proxiedTransport } from "./dial"
import { newDohCache } from "./doh"
import { startFakeDoh, type FakeDoh, type FakeRecords } from "./fake-doh"

// An exit end to end: a test SSH server that allows forwarding and sends
// a channel for the resolver's or a site's public address to a server of
// the test's on loopback.

const own = generateOwnKey("pcp-test")
const identity = { privateKey: own.privateKey }
const closers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  closeAllSshConnections()
  for (const close of closers.splice(0).reverse()) await close()
})

const SITE = "93.184.216.34"

async function site(): Promise<number> {
  const server = http.createServer((req, res) =>
    res.end(`hello from the site, ${req.headers.host}`),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return (server.address() as net.AddressInfo).port
}

async function setUp(records: FakeRecords) {
  const doh: FakeDoh = await startFakeDoh(records)
  closers.push(doh.close)
  const sitePort = await site()
  const ssh: FakeSsh = await startFakeSsh({
    authorizedKey: () => own.publicKey,
    run: () => ({}),
    allowForwarding: true,
    connectTo: (host, port) =>
      host === "1.1.1.1" && port === 443
        ? { host: "127.0.0.1", port: doh.port }
        : host === SITE
          ? { host: "127.0.0.1", port: sitePort }
          : null,
  })
  closers.push(ssh.close)
  const target: SshTarget = {
    host: "127.0.0.1",
    port: ssh.port,
    username: "deploy",
    hostKey: ssh.hostKey,
  }
  const { remoteAddress } = await ensureSshConnection("srv", target, identity)
  const dialer = makeExitDialer(
    { id: "exit1", name: "us-vps", label: "US" },
    {
      own: () => [remoteAddress ?? "127.0.0.1"],
      open: (address, port, signal) =>
        openChannel("srv", target, identity, address, port, { signal }),
    },
    {
      resolvers: [
        { address: "1.1.1.1", servername: doh.servername, ca: doh.ca },
      ],
      cache: newDohCache(),
    },
  )
  return { ssh, doh, dialer }
}

function get(socket: net.Socket | import("node:stream").Duplex, host: string) {
  return new Promise<string>((resolve, reject) => {
    const request = http.request(
      { host, path: "/", createConnection: () => socket as net.Socket },
      (response) => {
        let body = ""
        response.on("data", (chunk) => (body += chunk))
        response.on("end", () => resolve(body))
      },
    )
    request.on("error", reject)
    request.end()
  })
}

describe("an SSH exit", () => {
  it("looks the name up through the exit and dials the address it checked", async () => {
    const { ssh, doh, dialer } = await setUp({ "site.test": { a: [SITE] } })

    const socket = await dialer.dial("site.test", 80, { allowPrivate: false })
    expect(await get(socket, "site.test")).toBe(
      "hello from the site, site.test:80",
    )
    expect(doh.asked.sort()).toEqual(["A site.test", "AAAA site.test"])
    // The resolver by its address, then the site by the address checked.
    expect(ssh.forwards).toContain("1.1.1.1:443")
    expect(ssh.forwards).toContain(`${SITE}:80`)
  })

  it("refuses a name that answers with an address on the exit's network", async () => {
    const { ssh, dialer } = await setUp({
      "intranet.test": { a: ["10.0.0.5"] },
      "mixed.test": { a: [SITE, "192.168.1.1"] },
      "home.test": { a: ["127.0.0.1"] },
      "metadata.test": { a: ["169.254.169.254"] },
    })

    for (const name of ["intranet.test", "mixed.test", "metadata.test"]) {
      await expect(
        dialer.dial(name, 80, { allowPrivate: false }),
      ).rejects.toThrow(ExitAddressError)
    }

    // The exit's own loopback, even with private addresses allowed.
    await expect(
      dialer.dial("home.test", 80, { allowPrivate: true }),
    ).rejects.toThrow(/the exit us-vps itself/)
    await expect(
      dialer.dial("127.0.0.1", 22, { allowPrivate: true }),
    ).rejects.toThrow(ExitAddressError)

    // Nothing was dialed but the resolver.
    expect(ssh.forwards.every((entry) => entry === "1.1.1.1:443")).toBe(true)
  })

  it("lets a private address through only for a token with a private line", async () => {
    const { dialer } = await setUp({ "intranet.test": { a: ["10.0.0.5"] } })

    // Allowed, so it is dialed: the test server cannot reach it.
    await expect(
      dialer.dial("intranet.test", 80, { allowPrivate: true }),
    ).rejects.toThrow(/could not connect to 10\.0\.0\.5:80/)
  })
})

describe("a proxied transport (an exit container)", () => {
  it("opens the loopback channel and asks the proxy for the checked address", async () => {
    const asked: string[] = []
    const proxy = net.createServer((client) => {
      client.once("data", (data) => {
        asked.push(data.toString().split("\r\n")[0]!)
        client.write("HTTP/1.1 200 OK\r\n\r\n")
        client.on("data", () => client.end("HTTP/1.1 204 No Content\r\n\r\n"))
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    closers.push(
      () => new Promise<void>((resolve) => proxy.close(() => resolve())),
    )
    const port = (proxy.address() as net.AddressInfo).port
    const transport = proxiedTransport(
      async () => {
        const socket = net.connect(port, "127.0.0.1")
        await new Promise((resolve) => socket.once("connect", resolve))
        return socket
      },
      { protocol: "http" },
      () => [],
    )
    const dialer = makeExitDialer(
      { id: "exit2", name: "nl-vpn", label: "" },
      transport,
      { cache: newDohCache() },
    )

    const socket = await dialer.dial(SITE, 443, { allowPrivate: false })
    expect(asked).toEqual([`CONNECT ${SITE}:443 HTTP/1.1`])
    socket.destroy()
  })
})
