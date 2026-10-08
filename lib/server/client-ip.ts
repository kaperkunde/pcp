import "server-only"

import { createHash } from "node:crypto"
import { BlockList, isIP } from "node:net"

import { headers } from "next/headers"

/**
 * An address as a rate-limit key: itself when it is an IP address, otherwise
 * a short hash of it, so a header of any length costs the same few bytes and
 * the same value still lands on the same key.
 */
function addressKey(value: string): string {
  return isIP(value)
    ? value
    : `h:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`
}

/**
 * The proxies in front of PCP (`PCP_TRUSTED_PROXIES`: IP addresses and CIDR
 * ranges, comma-separated), or null while it is unset and the left-most
 * X-Forwarded-For counts, as it always has. Read on every call, parsed once
 * per value, so a bad entry is warned about once.
 */
let trusted: { raw: string; list: BlockList } | null = null

function trustedProxies(): BlockList | null {
  const raw = process.env.PCP_TRUSTED_PROXIES?.trim() ?? ""

  if (!raw) {
    return null
  }

  if (trusted?.raw !== raw) {
    trusted = { raw, list: parseTrustedProxies(raw) }
  }

  return trusted.list
}

function family(address: string): "ipv4" | "ipv6" | null {
  const version = isIP(address)

  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null
}

/**
 * The listed addresses and ranges, and loopback with them: PCP's own HTTPS
 * listeners and pcp.gg reach the app from 127.0.0.1. An entry that is
 * neither an address nor a range is left out, with a warning.
 */
export function parseTrustedProxies(raw: string): BlockList {
  const list = new BlockList()
  list.addSubnet("127.0.0.0", 8, "ipv4")
  list.addAddress("::1", "ipv6")

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()

    if (!trimmed) {
      continue
    }

    const [address, prefix, ...rest] = trimmed.split("/")
    const type = family(address)
    const bits = prefix === undefined ? null : Number(prefix)
    const valid =
      type !== null &&
      rest.length === 0 &&
      (prefix === undefined ||
        (/^\d{1,3}$/.test(prefix) && bits! <= (type === "ipv4" ? 32 : 128)))

    if (!valid) {
      console.warn(
        `PCP_TRUSTED_PROXIES: "${trimmed}" is not an IP address or a CIDR range; it is ignored.`,
      )
      continue
    }

    if (bits === null) {
      list.addAddress(address, type)
    } else {
      list.addSubnet(address, bits, type)
    }
  }

  return list
}

/** An IPv4 address a dual-stack socket reports as ::ffff:a.b.c.d. */
function unmapped(address: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]

  return v4 && isIP(v4) === 4 ? v4 : address
}

/**
 * The client behind the trusted proxies: X-Forwarded-For read from the
 * right, past every address that is one of them, to the first that is not.
 * Each proxy appends the address that connected to it, so whatever a client
 * wrote itself sits to the left of that and is never reached. When every
 * entry is trusted (a request from a proxy's own machine), the left-most.
 */
function behindProxies(entries: string[], list: BlockList): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const address = unmapped(entries[i])
    const type = family(address)

    if (!type || !list.check(address, type)) {
      return address
    }
  }

  return unmapped(entries[0])
}

/**
 * The client's address, for rate limits.
 *
 * Next (15.5, `server/base-server.js`) sets X-Forwarded-For to the socket's
 * address only when the request has none (`??=`), and never appends to it.
 * So the header is exactly what the nearest proxy sent, and the address that
 * connected to PCP is in it only when nothing set the header. PCP's own
 * HTTPS listeners and pcp.gg (lib/core/network/proxy.ts) replace it with the
 * address that connected to them.
 *
 * Without PCP_TRUSTED_PROXIES, the left-most entry counts (or X-Real-IP):
 * the client's address behind a proxy that replaces the header, but
 * whatever the client wrote behind one that appends. With it, the walk from
 * the right finds the client behind proxies that append, so a client cannot
 * spread its guesses over addresses it makes up. Neither helps a client
 * that reaches PCP's port without a proxy: Next leaves its header as it is.
 */
export async function clientIp(): Promise<string> {
  const hdrs = await headers()
  const list = trustedProxies()

  if (list) {
    const entries = (hdrs.get("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)

    // X-Real-IP is not read here: it is one more header a client can set,
    // and the proxies append to X-Forwarded-For.
    return entries.length > 0
      ? addressKey(behindProxies(entries, list))
      : "local"
  }

  const forwarded = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim()
  const reported = forwarded || hdrs.get("x-real-ip")?.trim()

  return reported ? addressKey(reported) : "local"
}
