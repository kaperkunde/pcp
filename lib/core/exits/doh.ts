import https from "node:https"
import type { Duplex } from "node:stream"
import tls from "node:tls"

import {
  decodeMessage,
  encodeQuery,
  followChain,
  normalizeName,
  TYPE_A,
  TYPE_AAAA,
  type QueryType,
} from "./dns-wire"
import {
  DOH_CACHE_ENTRIES,
  DOH_MAX_CNAME_HOPS,
  DOH_MAX_RESPONSE_BYTES,
  DOH_MAX_TTL_S,
  DOH_MIN_TTL_S,
  DOH_TIMEOUT_MS,
} from "./limits"

/**
 * Name lookups through an exit, as DNS-over-HTTPS (RFC 8484). Node's own
 * resolver cannot be given a connection to use, and a lookup from PCP's
 * machine would answer for PCP's network, not the exit's (and tell PCP's
 * resolver every site an exit is used for). So PCP asks a public resolver
 * itself, through the exit: a TLS connection to the resolver by its IP
 * address, its certificate checked against the resolver's name, one GET
 * with the query in it. Cloudflare's 1.1.1.1 first, Quad9's 9.9.9.9 when
 * that one fails. A and AAAA, CNAMEs followed; the answer is then checked
 * like any other address (exits/check.ts) by the caller, who dials the very
 * address it checked.
 *
 * Answers are kept per exit for their TTL (within bounds), at most
 * DOH_CACHE_ENTRIES of them.
 */

export type DohResolver = {
  /** Its IP address: what the exit connects to, so no lookup is needed. */
  address: string
  /** The name on its certificate, sent as SNI and checked. */
  servername: string
  /** Certificates to trust instead of Node's: tests only. */
  ca?: string | Buffer
}

export const DOH_RESOLVERS: readonly DohResolver[] = [
  { address: "1.1.1.1", servername: "cloudflare-dns.com" },
  { address: "9.9.9.9", servername: "dns.quad9.net" },
]

/** A raw connection from the exit to an address, as the exit opens one. */
export type RawConnect = (
  address: string,
  port: number,
  signal: AbortSignal,
) => Promise<Duplex>

export class DohError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DohError"
  }
}

type Cached = { addresses: string[]; until: number }

/** One exit's answers, newest last: the oldest go first when it is full. */
export type DohCache = Map<string, Cached>

export function newDohCache(): DohCache {
  return new Map()
}

function cacheKey(name: string, type: QueryType): string {
  return `${type} ${name}`
}

function fromCache(cache: DohCache, key: string): string[] | null {
  const hit = cache.get(key)

  if (!hit) return null

  if (hit.until <= Date.now()) {
    cache.delete(key)
    return null
  }

  return hit.addresses
}

function toCache(
  cache: DohCache,
  key: string,
  addresses: string[],
  ttl: number,
): void {
  const seconds = Math.min(DOH_MAX_TTL_S, Math.max(DOH_MIN_TTL_S, ttl))
  cache.delete(key)
  cache.set(key, { addresses, until: Date.now() + seconds * 1000 })

  while (cache.size > DOH_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value!)
  }
}

/** One GET to one resolver, through the exit. */
async function ask(
  resolver: DohResolver,
  query: Buffer,
  connect: RawConnect,
  signal: AbortSignal,
): Promise<Buffer> {
  const raw = await connect(resolver.address, 443, signal)

  return new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect({
      socket: raw,
      servername: resolver.servername,
      ALPNProtocols: ["http/1.1"],
      ...(resolver.ca ? { ca: resolver.ca } : {}),
    })
    socket.on("error", () => {})
    const request = https.request(
      {
        host: resolver.servername,
        port: 443,
        method: "GET",
        path: `/dns-query?dns=${query.toString("base64url")}`,
        headers: {
          accept: "application/dns-message",
          "accept-encoding": "identity",
        },
        createConnection: () => socket,
        signal,
      },
      (response) => {
        const type = String(response.headers["content-type"] ?? "")
          .split(";")[0]!
          .trim()
          .toLowerCase()

        if (response.statusCode !== 200 || type !== "application/dns-message") {
          response.destroy()
          reject(
            new DohError(
              `${resolver.servername} answered HTTP ${response.statusCode ?? "?"}${type ? ` (${type})` : ""}.`,
            ),
          )
          return
        }

        const chunks: Buffer[] = []
        let size = 0

        response.on("data", (chunk: Buffer) => {
          size += chunk.length

          if (size > DOH_MAX_RESPONSE_BYTES) {
            response.destroy()
            reject(
              new DohError(`${resolver.servername}'s answer was too long.`),
            )
            return
          }

          chunks.push(chunk)
        })
        response.on("end", () => resolve(Buffer.concat(chunks)))
        response.on("error", reject)
      },
    )

    request.on("error", (error) => {
      raw.destroy()
      reject(error)
    })
    request.on("close", () => socket.destroy())
    request.end()
  })
}

/** One question, to the first resolver that answers it. */
async function query(
  name: string,
  type: QueryType,
  {
    connect,
    resolvers,
    timeoutMs,
    signal,
  }: {
    connect: RawConnect
    resolvers: readonly DohResolver[]
    timeoutMs: number
    signal?: AbortSignal
  },
): Promise<{ addresses: string[]; name: string; ttl: number }> {
  const message = encodeQuery(name, type)
  let failure: unknown = new DohError("No resolver to ask.")

  for (const resolver of resolvers) {
    const deadline = AbortSignal.timeout(timeoutMs)
    const both = signal ? AbortSignal.any([signal, deadline]) : deadline

    try {
      const answer = decodeMessage(await ask(resolver, message, connect, both))
      const question = answer.questions[0]

      if (
        answer.id !== 0 ||
        answer.questions.length !== 1 ||
        question?.name !== normalizeName(name) ||
        question.type !== type
      ) {
        throw new DohError(
          `${resolver.servername} answered another question than the one asked.`,
        )
      }

      // No such name, or none of this type: an answer, not a failure.
      if (answer.rcode === 3) {
        return { addresses: [], name, ttl: DOH_MIN_TTL_S }
      }

      if (answer.rcode !== 0) {
        throw new DohError(
          `${resolver.servername} could not look ${name} up (DNS error ${answer.rcode}).`,
        )
      }

      return followChain(answer.answers, name, type)
    } catch (error) {
      signal?.throwIfAborted()
      failure = deadline.aborted
        ? new DohError(
            `${resolver.servername} did not answer within ${timeoutMs / 1000} seconds.`,
          )
        : error
    }
  }

  throw failure
}

/** A name's addresses of one type, CNAMEs followed across answers. */
async function lookupType(
  name: string,
  type: QueryType,
  options: Parameters<typeof query>[2] & { cache: DohCache },
): Promise<string[]> {
  const key = cacheKey(name, type)
  const cached = fromCache(options.cache, key)

  if (cached) return cached

  let current = name
  let ttl = DOH_MAX_TTL_S

  for (let hop = 0; hop <= DOH_MAX_CNAME_HOPS; hop++) {
    const answer = await query(current, type, options)
    ttl = Math.min(ttl, answer.ttl)

    if (answer.addresses.length > 0 || answer.name === current) {
      toCache(options.cache, key, answer.addresses, ttl)
      return answer.addresses
    }

    // The answer ended at an alias it had no records for: ask about that.
    current = answer.name
  }

  throw new DohError(`${name} has more than ${DOH_MAX_CNAME_HOPS} CNAMEs.`)
}

export type DohLookup = {
  connect: RawConnect
  cache: DohCache
  resolvers?: readonly DohResolver[]
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Every IPv4 and IPv6 address of `name`, looked up through the exit, IPv4
 * first. A name with neither is an error the caller passes on.
 */
export async function resolveThroughExit(
  name: string,
  {
    connect,
    cache,
    resolvers = DOH_RESOLVERS,
    timeoutMs = DOH_TIMEOUT_MS,
    signal,
  }: DohLookup,
): Promise<string[]> {
  const host = normalizeName(name)
  const options = { connect, cache, resolvers, timeoutMs, signal }
  const [v4, v6] = await Promise.allSettled([
    lookupType(host, TYPE_A, options),
    lookupType(host, TYPE_AAAA, options),
  ])
  const addresses = [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ]

  if (addresses.length === 0) {
    const failed = [v4, v6].find((result) => result.status === "rejected")

    if (failed) {
      throw (failed as PromiseRejectedResult).reason
    }

    throw new DohError(`${host} has no address.`)
  }

  return addresses
}
