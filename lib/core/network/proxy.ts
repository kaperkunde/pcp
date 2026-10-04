import http from "node:http"
import type { Duplex } from "node:stream"

/**
 * Forwards a request that came in on the edge listeners (edge.ts) to the
 * app on loopback, streaming both ways so an MCP stream stays open.
 *
 * These listeners face the internet directly, so the X-Forwarded-* headers
 * a client sent are replaced, never trusted: the app reads the scheme, host
 * and client address from them (lib/server/public-url.ts, client-ip.ts).
 */

export type ProxyTarget = { host: string; port: number }

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

function clientAddress(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")
}

export function forwardedHeaders(
  req: http.IncomingMessage,
  proto: "http" | "https",
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }

  for (const name of HOP_BY_HOP) {
    delete headers[name]
  }

  delete headers["forwarded"]
  delete headers["x-forwarded-port"]
  delete headers["x-real-ip"]
  headers["x-forwarded-proto"] = proto
  headers["x-forwarded-for"] = clientAddress(req)

  if (req.headers.host) {
    headers["x-forwarded-host"] = req.headers.host
  } else {
    delete headers["x-forwarded-host"]
  }

  return headers
}

export function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: ProxyTarget,
  proto: "http" | "https",
): void {
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, proto),
    },
    (answer) => {
      const headers = { ...answer.headers }

      for (const name of HOP_BY_HOP) {
        delete headers[name]
      }

      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers)
      // Server-sent events: send each chunk as it comes.
      res.flushHeaders()
      answer.pipe(res)
    },
  )

  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      res.end("PCP is starting or not answering. Try again in a moment.\n")
    } else {
      res.destroy()
    }
  })

  // A client that goes away takes the upstream request with it.
  res.on("close", () => {
    if (!res.writableFinished) {
      upstream.destroy()
    }
  })

  req.pipe(upstream)
}

/** An Upgrade request (a WebSocket): the two sockets joined after the handshake. */
export function proxyUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
  proto: "http" | "https",
): void {
  const headers = forwardedHeaders(req, proto)
  headers.connection = "Upgrade"
  headers.upgrade = req.headers.upgrade

  const upstream = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
  })

  upstream.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`]

    for (let i = 0; i < answer.rawHeaders.length; i += 2) {
      lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`)
    }

    socket.write(`${lines.join("\r\n")}\r\n\r\n`)

    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstreamSocket.write(head)

    upstreamSocket.pipe(socket).pipe(upstreamSocket)
    upstreamSocket.on("error", () => socket.destroy())
    socket.on("error", () => upstreamSocket.destroy())
  })

  upstream.on("response", (answer) => {
    // The app refused the upgrade: pass its answer on and close.
    socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n\r\n`)
  })

  upstream.on("error", () => socket.destroy())
  upstream.end()
}
