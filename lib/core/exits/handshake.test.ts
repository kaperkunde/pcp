import net from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import {
  httpConnect,
  ipv6Bytes,
  ProxyHandshakeError,
  socks5Connect,
} from "./handshake"

// Each test runs a tiny proxy on loopback that records what it was asked
// and answers as told, then talks to the client over the same socket.

let servers: net.Server[] = []
const sockets = new Set<net.Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
  servers = []
})

async function proxy(
  handle: (socket: net.Socket) => void,
): Promise<net.Socket> {
  const server = net.createServer((socket) => {
    sockets.add(socket)
    handle(socket)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  const socket = net.connect(port, "127.0.0.1")
  sockets.add(socket)
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  return socket
}

function read(socket: net.Socket): Promise<string> {
  return new Promise((resolve) =>
    socket.once("data", (data) => resolve(data.toString())),
  )
}

describe("httpConnect", () => {
  it("asks for the address and port, and hands back the tunnel", async () => {
    let asked = ""
    const socket = await proxy((client) => {
      client.once("data", (data) => {
        asked = data.toString()
        // The answer and the far end's first bytes in one write.
        client.write("HTTP/1.1 200 Connection established\r\n\r\nhello")
        client.on("data", (more) => client.write(`echo ${more}`))
      })
    })

    await httpConnect(socket, "93.184.216.34", 443, {
      auth: { username: "pcp", password: "s3cret" },
    })

    expect(asked).toBe(
      "CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443\r\nProxy-Authorization: Basic cGNwOnMzY3JldA==\r\n\r\n",
    )
    // What came after the answer is still there to read.
    expect(await read(socket)).toBe("hello")
    socket.write("x")
    expect(await read(socket)).toBe("echo x")
    socket.destroy()
  })

  it("brackets an IPv6 address", async () => {
    let asked = ""
    const socket = await proxy((client) => {
      client.once("data", (data) => {
        asked = data.toString()
        client.write("HTTP/1.0 200 OK\r\n\r\n")
      })
    })

    await httpConnect(socket, "2606:2800:220:1::1", 443)
    expect(asked.split("\r\n")[0]).toBe(
      "CONNECT [2606:2800:220:1::1]:443 HTTP/1.1",
    )
    socket.destroy()
  })

  it("says why a proxy refused", async () => {
    const refusing = (answer: string) =>
      proxy((client) => client.once("data", () => client.end(answer)))

    await expect(
      httpConnect(
        await refusing("HTTP/1.1 403 Forbidden\r\n\r\n"),
        "93.184.216.34",
        443,
      ),
    ).rejects.toThrow(/HTTP 403 Forbidden/)
    await expect(
      httpConnect(
        await refusing("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"),
        "93.184.216.34",
        443,
      ),
    ).rejects.toThrow(/user name and password/)
    await expect(
      httpConnect(await refusing("SSH-2.0-nope\r\n\r\n"), "93.184.216.34", 443),
    ).rejects.toThrow(/not answer in HTTP/)
  })

  it("never asks for a name", async () => {
    const socket = await proxy(() => {})
    await expect(httpConnect(socket, "example.com", 443)).rejects.toThrow(
      ProxyHandshakeError,
    )
    socket.destroy()
  })
})

describe("socks5Connect", () => {
  /** A SOCKS5 proxy that records each message and answers in turn. */
  function socks(replies: Buffer[], seen: Buffer[]) {
    return proxy((client) => {
      client.on("data", (data) => {
        seen.push(data)
        const reply = replies.shift()
        if (reply) client.write(reply)
      })
    })
  }

  it("connects to an IPv4 address without a password", async () => {
    const seen: Buffer[] = []
    const socket = await socks(
      [
        Buffer.from([5, 0]),
        Buffer.concat([
          Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
          Buffer.from("hi"),
        ]),
      ],
      seen,
    )

    await socks5Connect(socket, "93.184.216.34", 443)

    expect(seen.map((part) => part.toString("hex"))).toEqual([
      "050100",
      "050100015db8d82201bb",
    ])
    expect(await read(socket)).toBe("hi")
    socket.destroy()
  })

  it("signs in with a user name and password, and takes an IPv6 address", async () => {
    const seen: Buffer[] = []
    const socket = await socks(
      [
        Buffer.from([5, 2]),
        Buffer.from([1, 0]),
        Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(18)]),
      ],
      seen,
    )

    await socks5Connect(socket, "2606:2800:220:1::1", 80, {
      auth: { username: "pcp", password: "pw" },
    })

    expect(seen[0]!.toString("hex")).toBe("050102")
    expect(seen[1]!.toString("hex")).toBe("0103706370" + "02" + "7077")
    expect(seen[2]!.toString("hex")).toBe(
      "05010004" + "26062800022000010000000000000001" + "0050",
    )
    socket.destroy()
  })

  it("says why it was refused", async () => {
    const seen: Buffer[] = []
    await expect(
      socks5Connect(
        await socks(
          [Buffer.from([5, 0]), Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])],
          seen,
        ),
        "93.184.216.34",
        443,
      ),
    ).rejects.toThrow(/connection was refused/)
    await expect(
      socks5Connect(
        await socks([Buffer.from([5, 0xff])], []),
        "93.184.216.34",
        443,
      ),
    ).rejects.toThrow(/wants a user name and password/)
    await expect(
      socks5Connect(
        await socks([Buffer.from([5, 2]), Buffer.from([1, 1])], []),
        "93.184.216.34",
        443,
        { auth: { username: "pcp", password: "wrong" } },
      ),
    ).rejects.toThrow(/turned down/)
  })
})

describe("ipv6Bytes", () => {
  it("reads every spelling", () => {
    expect(ipv6Bytes("::1").toString("hex")).toBe(
      "00000000000000000000000000000001",
    )
    expect(ipv6Bytes("2001:db8::").toString("hex")).toBe(
      "20010db8000000000000000000000000",
    )
    expect(ipv6Bytes("::ffff:1.2.3.4").toString("hex")).toBe(
      "00000000000000000000ffff01020304",
    )
    expect(() => ipv6Bytes("1:2:3:4:5:6:7:8:9")).toThrow()
  })
})
