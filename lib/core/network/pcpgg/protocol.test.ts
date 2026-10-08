import net from "node:net"
import tls from "node:tls"
import { setTimeout as sleep } from "node:timers/promises"

import { describe, expect, it } from "vitest"

import {
  decodeFrame,
  encodeFrame,
  FrameType,
  INITIAL_WINDOW,
  ProtocolError,
} from "./frames"
import { isAcmeChallenge, parseHttpHead } from "./test-relay/http-head"
import { Mux, type MuxStream } from "./mux"
import { parseSni } from "./test-relay/sni"

/** The first bytes a real TLS client sends, for a given name. */
async function captureClientHello(servername?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        resolve(chunk)
        socket.destroy()
        server.close()
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      const client = tls.connect({ host: "127.0.0.1", port, servername })
      client.on("error", () => {})
    })
    server.on("error", reject)
  })
}

describe("parseSni", () => {
  it("reads the name from a real ClientHello", async () => {
    const hello = await captureClientHello("Alice.PCP.gg")
    expect(parseSni(hello)).toEqual({
      status: "done",
      serverName: "alice.pcp.gg",
    })
  })

  it("asks for more while the ClientHello is incomplete", async () => {
    const hello = await captureClientHello("alice.pcp.gg")
    expect(parseSni(hello.subarray(0, 3))).toEqual({ status: "more" })
    expect(parseSni(hello.subarray(0, hello.length - 1))).toEqual({
      status: "more",
    })
  })

  it("reassembles a ClientHello split over two TLS records", async () => {
    const hello = await captureClientHello("alice.pcp.gg")
    const body = hello.subarray(5)
    const cut = 40
    const record = (fragment: Buffer) =>
      Buffer.concat([
        Buffer.from([22, 3, 1, fragment.length >> 8, fragment.length & 255]),
        fragment,
      ])
    const split = Buffer.concat([
      record(body.subarray(0, cut)),
      record(body.subarray(cut)),
    ])
    expect(parseSni(split)).toEqual({
      status: "done",
      serverName: "alice.pcp.gg",
    })
  })

  it("answers null for a ClientHello without a name", async () => {
    const hello = await captureClientHello()
    expect(parseSni(hello)).toEqual({ status: "done", serverName: null })
  })

  it("rejects what is not TLS", () => {
    expect(parseSni(Buffer.from("GET / HTTP/1.1\r\n"))).toMatchObject({
      status: "invalid",
    })
  })
})

describe("parseHttpHead", () => {
  it("reads method, target and host", () => {
    expect(
      parseHttpHead(
        Buffer.from(
          "GET /.well-known/acme-challenge/abc HTTP/1.1\r\nHost: Alice.pcp.gg:80\r\n\r\n",
        ),
      ),
    ).toEqual({
      status: "done",
      method: "GET",
      target: "/.well-known/acme-challenge/abc",
      host: "alice.pcp.gg",
    })
  })

  it("waits for the end of the head", () => {
    expect(parseHttpHead(Buffer.from("GET / HTTP/1.1\r\nHo"))).toEqual({
      status: "more",
    })
  })

  it("knows a challenge from anything else", () => {
    expect(isAcmeChallenge("GET", "/.well-known/acme-challenge/a-B_9")).toBe(
      true,
    )
    expect(isAcmeChallenge("GET", "/.well-known/acme-challenge/../x")).toBe(
      false,
    )
    expect(isAcmeChallenge("POST", "/.well-known/acme-challenge/abc")).toBe(
      false,
    )
    expect(isAcmeChallenge("GET", "/login")).toBe(false)
  })
})

describe("frames", () => {
  it("round-trips", () => {
    const frame = decodeFrame(
      encodeFrame(FrameType.Data, 7, new Uint8Array([1, 2, 3])),
    )
    expect(frame.type).toBe(FrameType.Data)
    expect(frame.id).toBe(7)
    expect([...frame.payload]).toEqual([1, 2, 3])
  })

  it("refuses unknown types and stream 0", () => {
    expect(() => decodeFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow(
      ProtocolError,
    )
    expect(() => decodeFrame(new Uint8Array([2, 0, 0, 0, 0]))).toThrow(
      ProtocolError,
    )
  })
})

/** Two muxes joined back to back, as if over a WebSocket. */
function pair(initialWindow?: number) {
  const accepted: MuxStream[] = []
  const peers: { opener?: Mux; acceptor?: Mux } = {}
  const deliver = (target: () => Mux) => (frame: Uint8Array) =>
    queueMicrotask(() => target().receive(frame.slice()))
  const opener = new Mux(
    { send: deliver(() => peers.acceptor!), bufferedAmount: () => 0 },
    { role: "opener", initialWindow },
  )
  const acceptor = new Mux(
    { send: deliver(() => peers.opener!), bufferedAmount: () => 0 },
    {
      role: "acceptor",
      initialWindow,
      onStream: (stream) => accepted.push(stream),
    },
  )
  peers.opener = opener
  peers.acceptor = acceptor
  return { opener, acceptor, accepted }
}

describe("Mux", () => {
  it("carries a large transfer through a slow reader within the window", async () => {
    const { opener, accepted } = pair(64 * 1024)
    const stream = opener.open({ port: "https" })
    const payload = Buffer.alloc(3 * 1024 * 1024)

    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 251
    }

    stream.end(payload)
    await sleep(10)
    const remote = accepted[0]!
    const received: Buffer[] = []
    let maxBuffered = 0

    // Read slowly: a little at a time, with pauses.
    await new Promise<void>((resolve) => {
      remote.on("readable", async () => {
        let chunk: Buffer | null

        while ((chunk = remote.read(8192)) !== null) {
          received.push(chunk)
          maxBuffered = Math.max(maxBuffered, remote.readableLength)
        }
      })
      remote.on("end", () => resolve())
    })

    expect(Buffer.concat(received).equals(payload)).toBe(true)
    expect(maxBuffered).toBeLessThanOrEqual(64 * 1024 + 64 * 1024)
  })

  it("half-closes each direction separately", async () => {
    const { opener, accepted } = pair()
    const stream = opener.open({ port: "https" })
    stream.end("question")
    await sleep(10)
    const remote = accepted[0]!
    let question = ""
    remote.on("data", (chunk) => (question += chunk))
    await new Promise((resolve) => remote.on("end", resolve))
    expect(question).toBe("question")

    remote.end("answer")
    let answer = ""
    stream.on("data", (chunk) => (answer += chunk))
    await new Promise((resolve) => stream.on("end", resolve))
    expect(answer).toBe("answer")
  })

  it("resets the other side when one side is destroyed", async () => {
    const { opener, accepted } = pair()
    const stream = opener.open({ port: "https" })
    stream.write("x")
    await sleep(10)
    const remote = accepted[0]!
    const closed = new Promise((resolve) => remote.on("close", resolve))
    remote.on("error", () => {})
    stream.destroy()
    await closed
    expect(opener.size).toBe(0)
    expect(accepted[0]!.destroyed).toBe(true)
  })

  it("treats data beyond the window as a broken peer", async () => {
    const { acceptor, accepted } = pair()
    acceptor.receive(
      encodeFrame(FrameType.Open, 1, Buffer.from('{"port":"https"}')),
    )
    const remote = accepted[0]!
    const error = new Promise((resolve) => remote.on("error", resolve))
    const chunk = new Uint8Array(32 * 1024)

    for (let sent = 0; sent <= INITIAL_WINDOW; sent += chunk.length) {
      acceptor.receive(encodeFrame(FrameType.Data, 1, chunk))
    }

    expect(await error).toBeInstanceOf(ProtocolError)
  })

  it("refuses OPEN from the connector's side", () => {
    const { opener } = pair()
    expect(() =>
      opener.receive(
        encodeFrame(FrameType.Open, 1, Buffer.from('{"port":"https"}')),
      ),
    ).toThrow(ProtocolError)
  })
})
