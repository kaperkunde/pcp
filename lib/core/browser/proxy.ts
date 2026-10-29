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
 *
 * A tab that goes through an exit (lib/core/exits/) has a context of its
 * own whose proxy is one of these with `connect`: there the exit looks the
 * name up and checks every address from its own side, and the connection
 * leaves from the exit. Each exit's context has its own proxy, since a
 * proxy cannot tell tabs apart.
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

/** A refusal from `connect`: the verdict it carries, if it is one. */
function refusalOf(error: unknown): Refused | null {
  if (error instanceof Refused) return error
  const verdict = (error as { verdict?: unknown } | null)?.verdict
  // An exit's link-local and metadata addresses are refused for every
  // token, as its own are.
  return verdict === "private" || verdict === "own"
    ? new Refused(verdict)
    : verdict === "local"
      ? new Refused("own")
      : null
}

export async function startBrowserProxy({
  check,
  connect,
}: {
  /** Decides each address as the browser is about to connect to it. */
  check: AddressCheck
  /**
   * Dials somewhere else than from PCP's machine (an exit): resolves the
   * name, checks every address and connects, all on the exit's side. An
   * error with a `verdict` of "private", "own" or "local" is a refusal. Replaces
   * `check` and PCP's own lookup.
   */
  connect?: (host: string, port: number) => Promise<Duplex>
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
    const refused = refusalOf(error)

    if (refused) {
      refusals.set(bare(host).toLowerCase(), {
        verdict: refused.verdict,
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

    if (connect) {
      const headers = { ...req.headers }
      delete headers["proxy-connection"]
      delete headers["proxy-authorization"]

      const upstream = http.request({
        host: bare(target.hostname),
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
        timeout: PROXY_CONNECT_TIMEOUT_MS,
        createConnection: (_options, callback) => {
          connect(target.hostname, port).then(
            (socket) => callback(null, socket as net.Socket),
            (error: Error) => {
              remember(target.hostname, error)
              callback(error, undefined as unknown as net.Socket)
            },
          )
          return undefined
        },
      })

      upstream.on("response", (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.rawHeaders)
        answer.pipe(res)
      })
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")))
      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(refusalOf(error) ? 403 : 502)
        res.end()
      })
      req.pipe(upstream)
      return
    }

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

    if (connect) {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        client.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n")
      }, PROXY_CONNECT_TIMEOUT_MS)

      connect(authority.host, authority.port).then(
        (upstream) => {
          clearTimeout(timer)

          if (settled || client.destroyed) {
            upstream.destroy()
            return
          }

          settled = true
          track(upstream)
          upstream.on("error", () => client.destroy())
          client.on("close", () => upstream.destroy())
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")

          if (head.length > 0) {
            upstream.write(head)
          }

          upstream.pipe(client)
          client.pipe(upstream)
        },
        (error) => {
          clearTimeout(timer)
          remember(authority.host, error)
          if (settled) return
          settled = true
          client.end(
            refusalOf(error)
              ? "HTTP/1.1 403 Forbidden\r\n\r\n"
              : "HTTP/1.1 502 Bad Gateway\r\n\r\n",
          )
        },
      )
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
