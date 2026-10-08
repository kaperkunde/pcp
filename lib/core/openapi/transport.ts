import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { Readable } from "node:stream"

import { AddressBlockedError, bareHostname, isPublicAddress } from "./address"

/**
 * How a request leaves PCP. Normally that is fetch. For an endpoint that
 * only reaches public addresses it is a plain node:http(s) request whose
 * name lookup is checked: the address that is checked is the address the
 * socket connects to, so a name that answers with a public address to a
 * check and a private one to the connection (DNS rebinding) cannot get
 * through. An IP literal never goes through a lookup, so it is checked up
 * front.
 *
 * Neither path follows redirects: both hand the 3xx back to the caller.
 * checkedFetch can follow them, for an MCP server, by sending each hop again
 * through the same check.
 */

export type SendOptions = {
  /** Refuse private, loopback and link-local addresses. */
  publicOnly?: boolean
  /**
   * Replaces the address check: web_fetch's when the owner allowed private
   * addresses, and tests of the transport itself. Called with the address
   * the socket would connect to and the port.
   */
  addressCheck?: (address: string, port: number) => boolean
}

export type SendInit = {
  method?: string
  headers?: Record<string, string>
  /** Bytes go as they are (see asBytes in crypto.ts for a Buffer). */
  body?: string | Uint8Array<ArrayBuffer>
  signal?: AbortSignal
}

const NO_BODY = new Set([204, 205, 304])

/** What a reason phrase may contain for Response to take it. */
const SAFE_REASON = /^[\t\x20-\x7e\x80-\xff]*$/

export async function send(
  rawUrl: string,
  init: SendInit,
  options: SendOptions = {},
): Promise<Response> {
  if (!options.publicOnly) {
    return fetch(rawUrl, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: "manual",
      cache: "no-store",
    })
  }

  return sendPinned(
    new URL(rawUrl),
    init,
    options.addressCheck ?? isPublicAddress,
  )
}

function sendPinned(
  url: URL,
  init: SendInit,
  allowed: (address: string, port: number) => boolean,
): Promise<Response> {
  const host = bareHostname(url)
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80)

  if (isIP(host) && !allowed(host, port)) {
    return Promise.reject(new AddressBlockedError(host, host))
  }

  const lookup: NonNullable<http.RequestOptions["lookup"]> = (
    hostname,
    lookupOptions,
    callback,
  ) => {
    dns.lookup(hostname, { ...lookupOptions, all: true }, (error, found) => {
      if (error) {
        return (callback as (error: Error) => void)(error)
      }

      const addresses = found as dns.LookupAddress[]
      const bad = addresses.find((entry) => !allowed(entry.address, port))

      if (bad || addresses.length === 0) {
        return (callback as (error: Error) => void)(
          new AddressBlockedError(hostname, bad?.address ?? "no address"),
        )
      }

      if (lookupOptions.all) {
        return (callback as (e: null, a: dns.LookupAddress[]) => void)(
          null,
          addresses,
        )
      }

      return (callback as (e: null, a: string, f: number) => void)(
        null,
        addresses[0]!.address,
        addresses[0]!.family,
      )
    })
  }

  return new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http
    const request = transport.request(
      url,
      {
        method: init.method ?? "GET",
        headers: { "accept-encoding": "identity", ...init.headers },
        lookup,
        agent: false,
        signal: init.signal,
      },
      (res) => {
        // This runs as an event listener: an exception here would not reach
        // the promise, which would then wait out the timeout with the socket
        // held. Anything a hostile server can make it throw is turned into a
        // rejection instead.
        try {
          const status = res.statusCode ?? 502

          // Response only takes 200 to 599; a 101 without an upgrade, or a
          // made-up 999, is a server that is not speaking HTTP properly.
          if (status < 200 || status > 599) {
            throw new Error(`the server answered with HTTP ${status}`)
          }

          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            try {
              if (Array.isArray(value)) {
                for (const item of value) headers.append(name, item)
              } else if (value !== undefined) {
                headers.set(name, value)
              }
            } catch {
              // A header Headers will not hold is dropped, not fatal.
            }
          }

          const body = NO_BODY.has(status)
            ? null
            : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)

          if (body === null) {
            res.resume()
          }

          resolve(
            new Response(body, {
              status,
              statusText: SAFE_REASON.test(res.statusMessage ?? "")
                ? (res.statusMessage ?? "")
                : "",
              headers,
            }),
          )
        } catch (error) {
          res.destroy()
          reject(error)
        }
      },
    )

    request.on("error", reject)
    request.end(init.body)
  })
}

/** fetch's shape, as the MCP SDK takes it for its requests. */
export type FetchLike = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>

/** As many redirects as fetch follows before it gives up. */
const MAX_REDIRECTS = 20

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** What describes a body: dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
]

/** What fetch drops when a redirect leaves the origin. */
const CROSS_ORIGIN_DROPPED = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
]

/** A request body as send takes it: text or bytes, nothing else. */
function bodyOf(
  body: RequestInit["body"],
  headers: Record<string, string>,
): SendInit["body"] {
  if (body === undefined || body === null) {
    return undefined
  }

  if (typeof body === "string") {
    headers["content-type"] ??= "text/plain;charset=UTF-8"
    return body
  }

  if (body instanceof URLSearchParams) {
    headers["content-type"] ??=
      "application/x-www-form-urlencoded;charset=UTF-8"
    return body.toString()
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const view = ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array(body)

    // A copy, on an ArrayBuffer of its own.
    return new Uint8Array(view)
  }

  throw new TypeError("PCP sends a request body as text or bytes only.")
}

/**
 * fetch over send, for the MCP SDK (a server's transport and its OAuth
 * requests): every request is checked as send checks it. With
 * `followRedirects` a redirect is followed as fetch follows one (a 303, or a
 * 301 or 302 after a POST, becomes a GET without its body; leaving the origin
 * drops the Authorization and Cookie headers), each hop a request of its own
 * that is checked again, so a redirect cannot lead past the check. Without
 * it, the 3xx comes back to the caller, as from send.
 */
export function checkedFetch(
  options: SendOptions,
  { followRedirects = false }: { followRedirects?: boolean } = {},
): FetchLike {
  return async (input, init) => {
    let url = new URL(String(input))
    let method = (init?.method ?? "GET").toUpperCase()
    const headers = Object.fromEntries(new Headers(init?.headers))
    let body = bodyOf(init?.body, headers)
    const signal = init?.signal ?? undefined

    for (let hops = 0; ; hops++) {
      const response = await send(
        url.toString(),
        { method, headers, body, signal },
        options,
      )
      const location = response.headers.get("location")

      if (
        !followRedirects ||
        !REDIRECTS.has(response.status) ||
        location === null
      ) {
        return response
      }

      await response.body?.cancel().catch(() => {})

      if (hops >= MAX_REDIRECTS) {
        throw new TypeError("redirect count exceeded")
      }

      const next = new URL(location, url)

      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new TypeError("a redirect led to an address that is not http(s)")
      }

      if (
        (response.status === 303 && method !== "GET" && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET"
        body = undefined

        for (const name of BODY_HEADERS) delete headers[name]
      }

      if (next.origin !== url.origin) {
        for (const name of CROSS_ORIGIN_DROPPED) delete headers[name]
      }

      url = next
    }
  }
}
