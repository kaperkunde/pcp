import net, { type AddressInfo } from "node:net"
import tls from "node:tls"

import { describe, expect, it } from "vitest"

import { parseClientHello, peekClientHello } from "./client-hello"

// What the edge reads from a ClientHello while a TLS-ALPN-01 challenge is
// out: the name and the protocols, from a real one Node sends.

/** The first bytes a TLS client sends, as `options` make it. */
async function clientHello(
  options: Pick<tls.ConnectionOptions, "servername" | "ALPNProtocols">,
): Promise<Buffer> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const received = new Promise<Buffer>((resolve) =>
      server.once("connection", (socket) =>
        peekClientHello(socket).then(({ head }) => {
          resolve(head)
          socket.destroy()
        }),
      ),
    )
    const client = tls.connect({
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      rejectUnauthorized: false,
      ...options,
    })
    client.on("error", () => {})
    return await received
  } finally {
    server.close()
  }
}

describe("reading a ClientHello", () => {
  it("finds the name and the protocols", async () => {
    const hello = await clientHello({
      servername: "Alice.PCP.test",
      ALPNProtocols: ["acme-tls/1"],
    })

    expect(parseClientHello(hello)).toEqual({
      status: "done",
      serverName: "alice.pcp.test",
      protocols: ["acme-tls/1"],
    })
  })

  it("keeps the client's order, and says when there is no ALPN", async () => {
    expect(
      parseClientHello(
        await clientHello({
          servername: "alice.pcp.test",
          ALPNProtocols: ["h2", "http/1.1"],
        }),
      ),
    ).toMatchObject({ status: "done", protocols: ["h2", "http/1.1"] })

    expect(
      parseClientHello(await clientHello({ servername: "alice.pcp.test" })),
    ).toMatchObject({ status: "done", protocols: [] })
  })

  it("asks for more until it has the whole message, and refuses what is not TLS", async () => {
    const hello = await clientHello({
      servername: "alice.pcp.test",
      ALPNProtocols: ["acme-tls/1"],
    })

    expect(parseClientHello(hello.subarray(0, 3))).toEqual({ status: "more" })
    expect(parseClientHello(hello.subarray(0, hello.length - 1))).toEqual({
      status: "more",
    })
    expect(parseClientHello(Buffer.from("GET / HTTP/1.1\r\n"))).toMatchObject({
      status: "invalid",
    })
  })
})
