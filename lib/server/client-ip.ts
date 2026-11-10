import "server-only"

import { resolveClientIp } from "@kaperkunde/security"
import { headers } from "next/headers"

/** The header the server entry stamps with the address that connected. */
const PEER_HEADER = "x-pcp-peer"

let warned = false

/**
 * The client's address, for rate limits (@kaperkunde/security's
 * resolveClientIp, with PCP's trusted proxies).
 *
 * The server entries (docker/start.cjs, desktop/server-entry.cjs, through
 * docker/peer-stamp.cjs) stamp the address that connected to PCP into
 * x-pcp-peer, removing any the client sent; PCP's own HTTPS edge
 * (lib/core/network/proxy.ts) connects from loopback and replaces the
 * X-Forwarded-* headers with what it saw. With the peer known,
 * X-Forwarded-For and X-Real-IP count only from loopback or from an address
 * in PCP_TRUSTED_PROXIES; from any other peer they are a client's own text,
 * and the peer is the key. So a client that reaches PCP without a proxy
 * cannot choose its own key, and one behind a proxy PCP was not told about
 * is counted as that proxy (all of its clients share a key, the global cap
 * still holds) until PCP_TRUSTED_PROXIES names it. Say so once in the log.
 *
 * Without the stamp (`next dev`, tests), the headers are read as they were
 * before: the right-most X-Forwarded-For entry (X-Real-IP only when there is
 * none), or with PCP_TRUSTED_PROXIES, from the right past every listed proxy
 * to the first address that is not one. Read on every call, parsed once per
 * value, so a bad entry is warned about once.
 */
export async function clientIp(): Promise<string> {
  const found = resolveClientIp(await headers(), {
    trustedProxies: process.env.PCP_TRUSTED_PROXIES,
    peerHeader: PEER_HEADER,
  })

  if (found.untrustedForwarded && !warned) {
    warned = true
    // Never the address: nothing of a client goes in the log.
    console.warn(
      "PCP sees X-Forwarded-For or X-Real-IP from a connection that is not a proxy it trusts, and ignores them: every client behind it shares one rate-limit address. " +
        (process.env.PCP_TRUSTED_PROXIES?.trim()
          ? "PCP_TRUSTED_PROXIES does not include that proxy."
          : "PCP_TRUSTED_PROXIES is not set.") +
        " Behind a reverse proxy, set it to the proxy's address or range (under Docker it usually connects from the bridge network: PCP_TRUSTED_PROXIES=172.16.0.0/12). See docs/self-hosting.md.",
    )
  }

  return found.ip
}
