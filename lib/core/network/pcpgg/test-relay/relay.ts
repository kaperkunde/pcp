// A copy of tunnel/relay/relay.ts in kaperkunde/pcp-gg, for tests only.

import http from "node:http"
import net from "node:net"

import { WebSocketServer, type WebSocket } from "ws"

import { CloseCode, parseConnectorMessage, PROTOCOL_VERSION } from "../control"
import { ProtocolError } from "../frames"
import { httpResponse, isAcmeChallenge, parseHttpHead } from "./http-head"
import { bridge, Mux } from "../mux"
import { parseSni, peek, UNRECOGNIZED_NAME_ALERT } from "./sni"
import type { Directory, OnlineTunnel } from "./directory"

/**
 * The relay: three listeners and a table of names.
 *
 * - The tunnel listener takes the WebSocket each connector dials out on.
 * - The HTTPS listener (port 443) reads the name from each connection's
 *   ClientHello and passes the connection, still encrypted and byte for byte,
 *   down the tunnel for that name. It holds no certificate and no key, so it
 *   cannot read what passes through and cannot answer for any name itself.
 * - The HTTP listener (port 80) redirects to HTTPS, and passes on only Let's
 *   Encrypt's challenge requests, rewritten to a bare GET, so PCP can prove
 *   it holds its name and get its own certificate.
 *
 * Nothing is logged per connection: not who connected, not where from, not
 * how much. Tunnels coming and going are logged by device id.
 */

export type Target = { host: string; port: number }

export type RelayOptions = {
  directory: Directory
  /**
   * Where connections for names that are not a tunnel's go, untouched:
   * pcp.gg's own site when the relay shares an address with it.
   */
  fallbackHttps?: Target
  fallbackHttp?: Target
  /** Read the client address of tunnel connections from X-Forwarded-For. */
  trustProxy?: boolean
  log?: (event: string, fields?: Record<string, unknown>) => void
  reportIntervalMs?: number
  helloTimeoutMs?: number
  pingIntervalMs?: number
}

type Tunnel = {
  deviceId: string
  generation: number
  hostnames: string[]
  connectedAt: Date
  ws: WebSocket
  mux: Mux
}

const MAX_WS_PAYLOAD = 64 * 1024
const ACME_RESPONSE_LIMIT = 64 * 1024
const IDLE_TIMEOUT_MS = 60 * 60_000
const CONNECT_WINDOW_MS = 60_000
const CONNECTS_PER_WINDOW = 20

export type Relay = {
  httpsServer: net.Server
  httpServer: net.Server
  tunnelServer: http.Server
  /** The names currently online. */
  hostnames(): string[]
  close(): Promise<void>
}

export function createRelay(options: RelayOptions): Relay {
  const log = options.log ?? (() => {})
  const routes = new Map<string, Tunnel>()
  const byDevice = new Map<string, Tunnel>()
  const connectAttempts = new Map<string, { count: number; resetAt: number }>()

  // ---- reporting to the app ------------------------------------------------

  let reportTimer: NodeJS.Timeout | undefined
  let reporting = false

  const report = async () => {
    if (reporting) {
      return
    }

    reporting = true

    try {
      const online: OnlineTunnel[] = [...byDevice.values()].map((tunnel) => ({
        deviceId: tunnel.deviceId,
        generation: tunnel.generation,
        connectedAt: tunnel.connectedAt.toISOString(),
      }))
      const { disconnect } = await options.directory.report(online)

      for (const deviceId of disconnect) {
        const tunnel = byDevice.get(deviceId)

        if (tunnel) {
          log("tunnel.revoked", { device: deviceId })
          tunnel.ws.close(CloseCode.Revoked, "This key is no longer valid")
        }
      }
    } catch (error) {
      log("report.failed", { error: String(error) })
    } finally {
      reporting = false
    }
  }

  const reportSoon = () => {
    clearTimeout(reportTimer)
    reportTimer = setTimeout(report, 500)
  }

  const reportInterval = setInterval(report, options.reportIntervalMs ?? 60_000)

  // ---- the tunnel listener -------------------------------------------------

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD,
  })

  const tunnelServer = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end('{"ok":true}')
      return
    }

    response.writeHead(404, { "Content-Type": "text/plain" })
    response.end("Not found")
  })

  const clientAddress = (request: http.IncomingMessage): string => {
    const forwarded = request.headers["x-forwarded-for"]

    if (options.trustProxy && typeof forwarded === "string") {
      return forwarded.split(",").at(-1)?.trim() || "unknown"
    }

    return request.socket.remoteAddress ?? "unknown"
  }

  const allowConnect = (address: string): boolean => {
    const now = Date.now()
    const entry = connectAttempts.get(address)

    if (!entry || entry.resetAt <= now) {
      connectAttempts.set(address, {
        count: 1,
        resetAt: now + CONNECT_WINDOW_MS,
      })
      return true
    }

    entry.count += 1
    return entry.count <= CONNECTS_PER_WINDOW
  }

  const sweepAttempts = setInterval(() => {
    const now = Date.now()

    for (const [address, entry] of connectAttempts) {
      if (entry.resetAt <= now) {
        connectAttempts.delete(address)
      }
    }
  }, CONNECT_WINDOW_MS)

  tunnelServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://relay").pathname

    if (path !== "/v1/connect") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
      return
    }

    if (!allowConnect(clientAddress(request))) {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\n\r\n",
      )
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => acceptTunnel(ws))
  })

  const acceptTunnel = (ws: WebSocket) => {
    let tunnel: Tunnel | null = null
    let alive = true

    const helloTimer = setTimeout(
      () => ws.close(CloseCode.Protocol, "No hello"),
      options.helloTimeoutMs ?? 10_000,
    )

    const pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }

      alive = false
      ws.ping()
    }, options.pingIntervalMs ?? 30_000)

    ws.on("pong", () => {
      alive = true
    })

    ws.on("error", () => {})

    ws.on("close", () => {
      clearTimeout(helloTimer)
      clearInterval(pingTimer)

      if (!tunnel) {
        return
      }

      tunnel.mux.close()

      for (const name of tunnel.hostnames) {
        if (routes.get(name) === tunnel) {
          routes.delete(name)
        }
      }

      if (byDevice.get(tunnel.deviceId) === tunnel) {
        byDevice.delete(tunnel.deviceId)
        log("tunnel.down", { device: tunnel.deviceId })
        reportSoon()
      }
    })

    let authorizing = false

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      alive = true

      if (tunnel && isBinary) {
        try {
          tunnel.mux.receive(data)
        } catch (error) {
          if (error instanceof ProtocolError) {
            ws.close(CloseCode.Protocol, error.message.slice(0, 120))
          } else {
            throw error
          }
        }
        return
      }

      const message = isBinary ? null : parseConnectorMessage(data.toString())

      if (!message) {
        ws.close(CloseCode.Protocol, "Unexpected message")
        return
      }

      if (message.type === "ping") {
        ws.send('{"type":"pong"}')
        return
      }

      if (tunnel || authorizing) {
        ws.close(CloseCode.Protocol, "Hello twice")
        return
      }

      if (message.protocol !== PROTOCOL_VERSION) {
        ws.close(
          CloseCode.Unauthorized,
          "This connector is too old or too new for pcp.gg: update PCP",
        )
        return
      }

      authorizing = true
      clearTimeout(helloTimer)

      options.directory.authorize(message.token).then(
        (authorization) => {
          authorizing = false

          if (ws.readyState !== ws.OPEN) {
            return
          }

          if (!authorization || authorization.hostnames.length === 0) {
            ws.close(CloseCode.Unauthorized, "Unknown connection key")
            return
          }

          const previous = byDevice.get(authorization.deviceId)

          if (previous) {
            previous.ws.close(CloseCode.Replaced, "Connected again elsewhere")
          }

          tunnel = {
            ...authorization,
            connectedAt: new Date(),
            ws,
            mux: new Mux(
              {
                send: (frame) => ws.send(frame),
                bufferedAmount: () => ws.bufferedAmount,
              },
              { role: "opener" },
            ),
          }

          byDevice.set(tunnel.deviceId, tunnel)

          for (const name of tunnel.hostnames) {
            routes.set(name, tunnel)
          }

          ws.send(
            JSON.stringify({ type: "ready", hostnames: tunnel.hostnames }),
          )
          log("tunnel.up", { device: tunnel.deviceId })
          reportSoon()
        },
        (error: unknown) => {
          authorizing = false
          log("authorize.failed", { error: String(error) })
          ws.close(CloseCode.TryAgain, "pcp.gg is busy: trying again soon")
        },
      )
    })
  }

  // ---- the HTTPS listener: SNI routing, no decryption ----------------------

  const httpsServer = net.createServer(
    { allowHalfOpen: true, pauseOnConnect: true },
    (socket) => {
      socket.on("error", () => {})
      socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy())

      peek(socket, parseSni).then(
        ({ result, head }) => {
          if (result.status === "invalid") {
            socket.destroy()
            return
          }

          const tunnel = result.serverName
            ? routes.get(result.serverName)
            : undefined

          if (!tunnel) {
            if (options.fallbackHttps) {
              passTo(options.fallbackHttps, socket, head)
            } else {
              socket.end(UNRECOGNIZED_NAME_ALERT)
            }
            return
          }

          let stream

          try {
            stream = tunnel.mux.open({ port: "https" })
          } catch {
            socket.destroy()
            return
          }

          stream.write(head)
          bridge(socket, stream)
        },
        () => socket.destroy(),
      )
    },
  )

  // ---- the HTTP listener: redirects, and ACME challenges -------------------

  const httpServer = net.createServer(
    { allowHalfOpen: true, pauseOnConnect: true },
    (socket) => {
      socket.on("error", () => {})
      socket.setTimeout(30_000, () => socket.destroy())

      peek(socket, parseHttpHead, { maxBytes: 8192 }).then(
        ({ result, head }) => {
          if (result.status === "invalid") {
            socket.end(httpResponse(400, "Bad Request", {}, "Bad request\n"))
            return
          }

          const tunnel = result.host ? routes.get(result.host) : undefined

          if (!tunnel) {
            if (options.fallbackHttp) {
              passTo(options.fallbackHttp, socket, head)
            } else {
              socket.end(
                httpResponse(
                  404,
                  "Not Found",
                  {},
                  "No PCP is connected at this name.\n",
                ),
              )
            }
            return
          }

          if (isAcmeChallenge(result.method, result.target)) {
            forwardChallenge(tunnel, socket, result.method, result.target, [
              result.host!,
            ])
            return
          }

          const target = result.target.startsWith("/") ? result.target : "/"
          socket.end(
            httpResponse(308, "Permanent Redirect", {
              Location: `https://${result.host}${target}`,
            }),
          )
        },
        () => socket.destroy(),
      )
    },
  )

  const forwardChallenge = (
    tunnel: Tunnel,
    socket: net.Socket,
    method: string,
    target: string,
    [host]: string[],
  ) => {
    let stream

    try {
      stream = tunnel.mux.open({ port: "http" })
    } catch {
      socket.destroy()
      return
    }

    let received = 0
    stream.on("data", (chunk: Buffer) => {
      received += chunk.byteLength

      if (received > ACME_RESPONSE_LIMIT) {
        stream.destroy()
        socket.destroy()
        return
      }

      socket.write(chunk)
    })
    stream.on("end", () => socket.end())
    stream.on("error", () => socket.destroy())
    socket.on("close", () => stream.destroy())
    stream.write(
      `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: pcp.gg-relay\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    )
  }

  const passTo = (target: Target, socket: net.Socket, head: Buffer) => {
    const upstream = net.connect({ ...target, allowHalfOpen: true })
    upstream.on("error", () => {})
    upstream.write(head)
    bridge(socket, upstream)
  }

  return {
    httpsServer,
    httpServer,
    tunnelServer,
    hostnames: () => [...routes.keys()].sort(),
    async close() {
      clearInterval(reportInterval)
      clearInterval(sweepAttempts)
      clearTimeout(reportTimer)

      for (const tunnel of byDevice.values()) {
        tunnel.ws.close(CloseCode.TryAgain, "pcp.gg is restarting")
      }

      await Promise.all(
        [httpsServer, httpServer, tunnelServer].map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve()
                return
              }
              server.close(() => resolve())
              if (server instanceof http.Server) {
                server.closeAllConnections()
              }
            }),
        ),
      )
      wss.close()
    },
  }
}
