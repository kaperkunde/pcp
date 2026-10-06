import http from "node:http"
import https from "node:https"
import type { AddressInfo, Socket } from "node:net"
import tls from "node:tls"

import { normalizeServerName, peekClientHello } from "./client-hello"
import { proxyRequest, proxyUpgrade, type ProxyTarget } from "./proxy"
import type { Certificate, ChallengeStore } from "./tls"

/**
 * The listeners PCP opens itself when HTTPS is on: plain HTTP (port 80) for
 * Let's Encrypt's HTTP-01 challenge and a redirect, and HTTPS (port 443)
 * with the certificate and the TLS-ALPN-01 challenge. Both forward to the
 * app on loopback (proxy.ts). Nothing here runs unless the owner turned
 * HTTPS on.
 */

const CHALLENGE_PREFIX = "/.well-known/acme-challenge/"

/** The protocol Let's Encrypt offers, and only it, to validate TLS-ALPN-01. */
export const ACME_TLS_PROTOCOL = "acme-tls/1"

export type ListenerStatus = {
  port: number
  listening: boolean
  error?: string
}

export type EdgeStatus = { http: ListenerStatus; https: ListenerStatus }

export function httpPort(): number {
  return portFromEnv("PCP_HTTP_PORT", 80)
}

export function httpsPort(): number {
  return portFromEnv("PCP_HTTPS_PORT", 443)
}

/** Where the app itself listens (Next's PORT). */
export function appTarget(): ProxyTarget {
  return { host: "127.0.0.1", port: portFromEnv("PORT", 3000) }
}

function portFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= 0 && value < 65536
    ? value
    : fallback
}

/** A listen failure in words an owner can act on. */
export function listenError(port: number, error: unknown): string {
  const code = (error as { code?: string }).code

  if (code === "EADDRINUSE") {
    return `Port ${port} is already in use by another program on this computer.`
  }

  if (code === "EACCES") {
    return `PCP is not allowed to use port ${port}. Run it in Docker (which maps the ports), or set PCP_HTTP_PORT and PCP_HTTPS_PORT to ports above 1024.`
  }

  return `PCP could not listen on port ${port}: ${
    error instanceof Error ? error.message : String(error)
  }.`
}

export class Edge {
  private httpServer: http.Server | null = null
  private httpsServer: https.Server | null = null
  /**
   * Answers TLS-ALPN-01 validations with the challenge certificate. It
   * never listens: port 443 hands it the connections that ask for
   * `acme-tls/1` at a name with a challenge waiting.
   */
  private readonly challengeServer: tls.Server
  /** Every connection port 443 took, so stop() can close them all. */
  private readonly sockets = new Set<Socket>()
  private certificate: Certificate | null = null
  private domain: string | null = null
  readonly status: EdgeStatus

  constructor(
    private readonly options: {
      target: ProxyTarget
      challenges: ChallengeStore
      httpPort: number
      httpsPort: number
      /**
       * The address to listen on: every interface when unset, as a
       * router's forward needs; 127.0.0.1 when only the pcp.gg connector
       * (pcpgg/connector.ts) reaches the listeners.
       */
      host?: string
    },
  ) {
    this.status = {
      http: { port: options.httpPort, listening: false },
      https: { port: options.httpsPort, listening: false },
    }
    this.challengeServer = tls.createServer({
      ALPNProtocols: [ACME_TLS_PROTOCOL],
      handshakeTimeout: 10_000,
      SNICallback: (name, done) => {
        const answer = this.options.challenges.tlsAlpn.get(
          normalizeServerName(name) ?? "",
        )
        done(null, answer ? tls.createSecureContext(answer) : undefined)
      },
    })
    // RFC 8737: the handshake is the whole answer; nothing else is said.
    this.challengeServer.on("secureConnection", (socket) => socket.end())
    this.challengeServer.on("tlsClientError", (_error, socket) =>
      socket.destroy(),
    )
  }

  get host(): string | undefined {
    return this.options.host
  }

  /**
   * Opens ports 80 and 443 (those not open yet) for the name. Port 443 opens
   * before there is a certificate, for the TLS-ALPN-01 challenge; until one
   * arrives, every other handshake there fails.
   */
  async start(domain: string): Promise<void> {
    this.domain = domain
    await Promise.all([this.openHttp(), this.openHttps()])
  }

  /** Serves `certificate` on port 443, opening it if it is not open yet. */
  async useCertificate(certificate: Certificate): Promise<void> {
    this.certificate = certificate
    // New connections get the new certificate, no restart.
    this.httpsServer?.setSecureContext({
      key: certificate.key,
      cert: certificate.cert,
    })
    await this.openHttps()
  }

  private async openHttp(): Promise<void> {
    if (this.httpServer) {
      return
    }

    const server = http.createServer((req, res) => this.handleHttp(req, res))
    server.on("upgrade", (req, socket, head) =>
      proxyUpgrade(req, socket, head, this.options.target, "http"),
    )
    this.httpServer = server

    if (!(await this.listen(server, this.status.http))) {
      // Tried again at the next reconcile.
      this.httpServer = null
    }
  }

  private async openHttps(): Promise<void> {
    if (this.httpsServer) {
      return
    }

    const certificate = this.certificate
    const server = https.createServer(
      certificate ? { key: certificate.key, cert: certificate.cert } : {},
      (req, res) => proxyRequest(req, res, this.options.target, "https"),
    )
    server.on("upgrade", (req, socket, head) =>
      proxyUpgrade(req, socket, head, this.options.target, "https"),
    )

    // The TLS server starts its handshake from its "connection" listener.
    // Each connection passes through route() first, which hands it on to
    // that handshake or to the challenge server.
    const handshakes = server.listeners("connection") as ((
      socket: Socket,
    ) => void)[]
    server.removeAllListeners("connection")
    server.on("connection", (socket: Socket) =>
      this.route(socket, (passed) => {
        for (const handshake of handshakes) handshake.call(server, passed)
      }),
    )
    this.httpsServer = server

    if (!(await this.listen(server, this.status.https))) {
      this.httpsServer = null
    }
  }

  /**
   * Sends Let's Encrypt's TLS-ALPN-01 validation to the challenge server and
   * every other connection to the HTTPS server. Only while a challenge is
   * waiting is the ClientHello read first; otherwise a connection goes
   * straight on.
   */
  private route(socket: Socket, handshake: (socket: Socket) => void): void {
    this.sockets.add(socket)
    socket.once("close", () => this.sockets.delete(socket))

    if (this.options.challenges.tlsAlpn.size === 0) {
      handshake(socket)
      return
    }

    peekClientHello(socket).then(
      ({ result, head }) => {
        socket.unshift(head)
        const validation =
          result.status === "done" &&
          result.serverName !== null &&
          result.protocols.length === 1 &&
          result.protocols[0] === ACME_TLS_PROTOCOL &&
          this.options.challenges.tlsAlpn.has(result.serverName)

        if (validation) {
          this.challengeServer.emit("connection", socket)
        } else {
          handshake(socket)
        }
      },
      () => socket.destroy(),
    )
  }

  async stop(): Promise<void> {
    await Promise.all(
      [this.httpServer, this.httpsServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server?.listening) {
              resolve()
              return
            }

            server.close(() => resolve())
            server.closeAllConnections()

            if (server === this.httpsServer) {
              for (const socket of this.sockets) socket.destroy()
            }
          }),
      ),
    )
    this.httpServer = null
    this.httpsServer = null
    this.certificate = null
    this.status.http = { port: this.options.httpPort, listening: false }
    this.status.https = { port: this.options.httpsPort, listening: false }
  }

  /** The ports actually bound (tests listen on port 0). */
  boundPorts(): { http?: number; https?: number } {
    const port = (server: http.Server | https.Server | null) =>
      server?.listening ? (server.address() as AddressInfo).port : undefined

    return { http: port(this.httpServer), https: port(this.httpsServer) }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? "/"

    if (url.startsWith(CHALLENGE_PREFIX)) {
      const answer = this.options.challenges.http.get(
        url.slice(CHALLENGE_PREFIX.length),
      )
      res.writeHead(answer ? 200 : 404, {
        "content-type": "text/plain; charset=utf-8",
      })
      res.end(answer ?? "Not found\n")
      return
    }

    // Once HTTPS works, plain HTTP only points there. Until then the site
    // stays usable over HTTP.
    if (this.certificate && this.domain && this.status.https.listening) {
      res.writeHead(308, { location: `https://${this.domain}${url}` })
      res.end()
      return
    }

    proxyRequest(req, res, this.options.target, "http")
  }

  private listen(
    server: http.Server | https.Server,
    status: ListenerStatus,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const failed = (error: Error) => {
        status.listening = false
        status.error = listenError(status.port, error)
        console.error(`[network] ${status.error}`)
        resolve(false)
      }

      server.once("error", failed)
      server.listen({ port: status.port, host: this.options.host }, () => {
        server.off("error", failed)
        status.listening = true
        delete status.error
        resolve(true)
      })
    })
  }
}
