import http from "node:http"
import net, { type AddressInfo } from "node:net"

import { afterEach, beforeEach, expect, it } from "vitest"

import { proxyRequest } from "./proxy"

// What the edge listeners hand the app: a body framed by chunks stays one
// request's body, and no connection to the app carries two clients.

type Seen = {
  method?: string
  url?: string
  forwardedFor?: string
  body: string
}

let app: http.Server
let proxy: http.Server
let proxyPort: number
let seen: Seen[]
/** Connections the app accepted. */
let connections: number

beforeEach(async () => {
  seen = []
  connections = 0
  app = http.createServer((req, res) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => (body += chunk))
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        forwardedFor: req.headers["x-forwarded-for"] as string | undefined,
        body,
      })
      res.end(`app saw ${req.method} ${req.url}`)
    })
  })
  app.on("connection", () => connections++)
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve))
  const target = {
    host: "127.0.0.1",
    port: (app.address() as AddressInfo).port,
  }

  proxy = http.createServer((req, res) =>
    proxyRequest(req, res, target, "https"),
  )
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  proxyPort = (proxy.address() as AddressInfo).port
})

afterEach(async () => {
  for (const server of [proxy, app]) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

/** Writes `raw` on a connection of its own and reads until one answer is whole. */
function rawRequest(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1")
    let answer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      answer += chunk
      const length = /content-length: (\d+)/i.exec(answer)
      const end = answer.indexOf("\r\n\r\n")

      if (length && end >= 0 && answer.length >= end + 4 + Number(length[1])) {
        socket.destroy()
        resolve(answer)
      }
    })
    socket.on("error", reject)
    socket.write(raw)
  })
}

function get(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port: proxyPort, path, agent: false },
        (res) => {
          let body = ""
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => (body += chunk))
          res.on("end", () => resolve(body))
        },
      )
      .on("error", reject)
  })
}

function chunked(body: string): string {
  return `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
}

it("keeps a chunked GET's body from reaching the app as a request of its own", async () => {
  const smuggled =
    "GET /smuggled HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 6.6.6.6\r\n\r\n"

  const answer = await rawRequest(
    "GET /outer HTTP/1.1\r\nHost: pcp.example\r\n" +
      `Transfer-Encoding: chunked\r\n\r\n${chunked(smuggled)}`,
  )

  expect(answer).toMatch(/app saw GET \/outer$/)
  // Another client, on a connection of its own, gets its own answer.
  expect(await get("/next")).toBe("app saw GET /next")
  expect(seen).toEqual([
    {
      method: "GET",
      url: "/outer",
      forwardedFor: "127.0.0.1",
      body: smuggled,
    },
    { method: "GET", url: "/next", forwardedFor: "127.0.0.1", body: "" },
  ])
  expect(connections).toBe(2)
})

it("passes a chunked POST's body on whole", async () => {
  const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}'

  const answer = await rawRequest(
    "POST /mcp HTTP/1.1\r\nHost: pcp.example\r\n" +
      `Transfer-Encoding: chunked\r\n\r\n${chunked(body)}`,
  )

  expect(answer).toMatch(/app saw POST \/mcp$/)
  expect(seen).toEqual([
    { method: "POST", url: "/mcp", forwardedFor: "127.0.0.1", body },
  ])
})
