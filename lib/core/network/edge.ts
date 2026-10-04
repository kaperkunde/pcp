import http from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"

import { proxyRequest, proxyUpgrade, type ProxyTarget } from "./proxy"
import type { Certificate, ChallengeStore } from "./tls"

/**
 * The listeners PCP opens itself when HTTPS is on: plain HTTP (port 80) for
 * Let's Encrypt's challenge and a redirect, and HTTPS (port 443) with the
 * certificate. Both forward to the app on loopback (proxy.ts). Nothing here
 * runs unless the owner turned HTTPS on.
 */

const CHALLENGE_PREFIX = "/.well-known/acme-challenge/"

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
  private certificate: Certificate | null = null
  private domain: string | null = null
  readonly status: EdgeStatus

  constructor(
    private readonly options: {
      target: ProxyTarget
      challenges: ChallengeStore
      httpPort: number
      httpsPort: number
    },
  ) {
    this.status = {
      http: { port: options.httpPort, listening: false },
      https: { port: options.httpsPort, listening: false },
    }
  }

  /** Opens port 80 (if not open yet) for the name. */
  async start(domain: string): Promise<void> {
    this.domain = domain

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

  /** Serves `certificate` on port 443, opening it the first time. */
  async useCertificate(certificate: Certificate): Promise<void> {
    this.certificate = certificate

    if (this.httpsServer) {
      // A renewal: new connections get the new certificate, no restart.
      this.httpsServer.setSecureContext({
        key: certificate.key,
        cert: certificate.cert,
      })
      return
    }

    const server = https.createServer(
      { key: certificate.key, cert: certificate.cert },
      (req, res) => proxyRequest(req, res, this.options.target, "https"),
    )
    server.on("upgrade", (req, socket, head) =>
      proxyUpgrade(req, socket, head, this.options.target, "https"),
    )
    this.httpsServer = server

    if (!(await this.listen(server, this.status.https))) {
      this.httpsServer = null
    }
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
      const answer = this.options.challenges.get(
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
      server.listen(status.port, () => {
        server.off("error", failed)
        status.listening = true
        delete status.error
        resolve(true)
      })
    })
  }
}
