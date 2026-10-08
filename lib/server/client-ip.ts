import "server-only"

import { createHash } from "node:crypto"
import { isIP } from "node:net"

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

/** The client's address as the nearest proxy reports it, for rate limits. */
export async function clientIp(): Promise<string> {
  const hdrs = await headers()
  const forwarded = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim()
  const reported = forwarded || hdrs.get("x-real-ip")?.trim()

  return reported ? addressKey(reported) : "local"
}
