import "server-only"

import { headers } from "next/headers"

/** The client's address as the nearest proxy reports it, for rate limits. */
export async function clientIp(): Promise<string> {
  const hdrs = await headers()
  const forwarded = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim()

  return forwarded || hdrs.get("x-real-ip") || "local"
}
