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
 */

export type SendOptions = {
  /** Refuse private, loopback and link-local addresses. */
  publicOnly?: boolean
  /** Replaces the address check; for tests of the transport itself. */
  addressCheck?: (address: string) => boolean
}

export type SendInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

const NO_BODY = new Set([101, 204, 205, 304])

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
  allowed: (address: string) => boolean,
): Promise<Response> {
  const host = bareHostname(url)

  if (isIP(host) && !allowed(host)) {
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
      const bad = addresses.find((entry) => !allowed(entry.address))

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
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item)
          } else if (value !== undefined) {
            headers.set(name, value)
          }
        }

        const status = res.statusCode ?? 502
        const body = NO_BODY.has(status)
          ? null
          : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)

        if (body === null) {
          res.resume()
        }

        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? "",
            headers,
          }),
        )
      },
    )

    request.on("error", reject)
    request.end(init.body)
  })
}
