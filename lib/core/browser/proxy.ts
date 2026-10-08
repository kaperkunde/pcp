import dns from "node:dns"
import http from "node:http"
import net, { isIP } from "node:net"
import type { Duplex } from "node:stream"

import { PROXY_CONNECT_TIMEOUT_MS } from "./limits"

/**
 * The forward proxy every connection of the browser goes through. Chromium
 * resolves names itself and would reach any address a page names; through
 * this proxy (launched with `--proxy-server` and loopback not bypassed)
 * PCP resolves each name, checks every address it answers with, and dials
 * the address it checked, so a page, a redirect, a script or an image
 * cannot reach the owner's network or PCP itself unless the check says so,
 * and a name that answers one way to a check and another to the connection
 * (DNS rebinding) gets nowhere.
 *
 * HTTPS and WebSockets arrive as CONNECT tunnels, plain HTTP as requests
 * with an absolute URL. Nothing is decrypted, rewritten or logged: which
 * hosts the browser reached stays out of PCP's logs, as web_fetch's sites
 * do.
 */

/** Why an address was refused, or "ok". */
export type AddressVerdict = "ok" | "private" | "own"

export type BrowserProxy = {
  port: number
  /** Why a host was refused since a time (epoch ms), if it was. */
  refusal: (
    host: string,
    since?: number,
  ) => Exclude<AddressVerdict, "ok"> | null
  close: () => Promise<void>
}

const REFUSALS_KEPT_MS = 30_000

class Refused extends Error {
  constructor(readonly verdict: Exclude<AddressVerdict, "ok">) {
    super(`refused: ${verdict}`)
  }
}

function bare(host: string): string {
  return host.replace(/^\[|\]$/g, "")
}

/** Decides one address the browser is about to connect to, for a host. */
export type AddressCheck = (
  address: string,
  port: number,
  /** The name the browser asked for, lower case, without brackets. */
  host: string,
) => AddressVerdict

async function resolveChecked(
  host: string,
  port: number,
  check: AddressCheck,
): Promise<string> {
  const name = bare(host).toLowerCase()

  if (isIP(name)) {
    const verdict = check(name, port, name)

    if (verdict !== "ok") {
      throw new Refused(verdict)
    }

    return name
  }

  const found = await dns.promises.lookup(name, { all: true, verbatim: true })

  if (found.length === 0) {
    throw new Error("no address")
  }

  // Every address the name has must pass: the one the socket would pick
  // is not ours to choose.
  for (const entry of found) {
    const verdict = check(entry.address, port, name)

    if (verdict !== "ok") {
      throw new Refused(verdict)
    }
  }

  return found[0]!.address
}

function parseAuthority(
  authority: string,
): { host: string; port: number } | null {
  try {
    const url = new URL(`http://${authority}`)
    const port = Number(url.port || 443)

    if (!url.hostname || url.username || url.password || url.pathname !== "/") {
      return null
    }

    return Number.isInteger(port) && port > 0 && port < 65536
      ? { host: url.hostname, port }
      : null
  } catch {
    return null
  }
}

export async function startBrowserProxy({
  check,
}: {
  /** Decides each address as the browser is about to connect to it. */
  check: AddressCheck
}): Promise<BrowserProxy> {
  const sockets = new Set<Duplex>()
  const refusals = new Map<
    string,
    { verdict: Exclude<AddressVerdict, "ok">; at: number }
  >()

  const track = (socket: Duplex) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }

  const remember = (host: string, error: unknown) => {
    if (error instanceof Refused) {
      refusals.set(bare(host).toLowerCase(), {
        verdict: error.verdict,
        at: Date.now(),
      })

      for (const [key, value] of refusals) {
        if (Date.now() - value.at > REFUSALS_KEPT_MS) refusals.delete(key)
      }
    }
  }

  const server = http.createServer((req, res) => {
    let target: URL

    try {
      target = new URL(req.url ?? "")
    } catch {
      res.writeHead(400).end()
      return
    }

    if (target.protocol !== "http:" || target.username || target.password) {
      res.writeHead(400).end()
      return
    }

    const port = Number(target.port || 80)

    resolveChecked(target.hostname, port, check).then(
      (address) => {
        const headers = { ...req.headers }
        delete headers["proxy-connection"]
        delete headers["proxy-authorization"]

        const upstream = http.request({
          host: address,
          port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
          setHost: false,
          agent: false,
          timeout: PROXY_CONNECT_TIMEOUT_MS,
        })

        upstream.on("response", (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.rawHeaders)
          answer.pipe(res)
        })
        upstream.on("timeout", () => upstream.destroy(new Error("timeout")))
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
        req.pipe(upstream)
      },
      (error) => {
        remember(target.hostname, error)
        res.writeHead(error instanceof Refused ? 403 : 502).end()
      },
    )
  })

  server.on("connect", (req, client: Duplex, head: Buffer) => {
    track(client)
    client.on("error", () => client.destroy())
    const authority = parseAuthority(req.url ?? "")

    if (!authority) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }

    resolveChecked(authority.host, authority.port, check).then(
      (address) => {
        const upstream = net.connect({ host: address, port: authority.port })
        track(upstream)
        upstream.setTimeout(PROXY_CONNECT_TIMEOUT_MS, () =>
          upstream.destroy(new Error("timeout")),
        )

        upstream.once("connect", () => {
          upstream.setTimeout(0)
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")

          if (head.length > 0) {
            upstream.write(head)
          }

          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on("error", () => {
          if (upstream.connecting) {
            client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
          } else {
            client.destroy()
          }
        })
        client.on("close", () => upstream.destroy())
      },
      (error) => {
        remember(authority.host, error)
        client.end(
          error instanceof Refused
            ? "HTTP/1.1 403 Forbidden\r\n\r\n"
            : "HTTP/1.1 502 Bad Gateway\r\n\r\n",
        )
      },
    )
  })

  server.on("connection", (socket) => track(socket))
  server.on("clientError", (_error, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const { port } = server.address() as net.AddressInfo

  return {
    port,
    refusal: (host, since = 0) => {
      const entry = refusals.get(bare(host).toLowerCase())
      return entry &&
        entry.at >= since &&
        Date.now() - entry.at <= REFUSALS_KEPT_MS
        ? entry.verdict
        : null
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
