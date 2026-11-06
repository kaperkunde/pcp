import "server-only"

import { clientIpFromHeaders } from "@kaperkunde/security"
import { headers } from "next/headers"

/**
 * The client's address, for rate limits (@kaperkunde/security's
 * clientIpFromHeaders, with PCP's trusted proxies).
 *
 * Next (16.3, `server/base-server.js`) sets X-Forwarded-For to the socket's
 * address only when the request has none (`??=`), and never appends to it.
 * So the header is exactly what the nearest proxy sent, and the address that
 * connected to PCP is in it only when nothing set the header. PCP's own
 * HTTPS listeners and pcp.gg (lib/core/network/proxy.ts) replace it with the
 * address that connected to them.
 *
 * Without PCP_TRUSTED_PROXIES, the right-most entry counts (X-Real-IP only
 * when there is no X-Forwarded-For): the address the one proxy in front
 * appended, or the only entry behind one that replaces the header. With it
 * (IP addresses and CIDR ranges, comma-separated, loopback always among
 * them), the header is read from the right past every listed proxy to the
 * first address that is not one, so a client cannot spread its guesses over
 * addresses it makes up behind several proxies either; X-Real-IP is not read
 * then. Neither helps a client that reaches PCP's port without a proxy: Next
 * leaves its header as it is. Read on every call, parsed once per value, so
 * a bad entry is warned about once.
 */
export async function clientIp(): Promise<string> {
  return clientIpFromHeaders(await headers(), {
    trustedProxies: process.env.PCP_TRUSTED_PROXIES,
  })
}
