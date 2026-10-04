import { isIP } from "node:net"

import { isPublicAddress } from "./openapi/address"

/**
 * Whether an address of PCP's own is one only the owner's machine or home
 * network can reach: localhost, a private or link-local IP, a name without a
 * dot (a hostname on the LAN) or one under a suffix routers and mDNS use
 * (`.local`, `.lan`, `.home`, `.internal`, `.home.arpa`). It decides when
 * the Settings page explains how to reach PCP from outside: an assistant
 * that runs elsewhere cannot use such an address.
 */

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".home",
  ".internal",
  ".home.arpa",
  ".localdomain",
]

export function isLocalHostname(hostname: string): boolean {
  const bare = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "")

  if (bare === "" || bare === "localhost") {
    return true
  }

  if (isIP(bare) !== 0) {
    return !isPublicAddress(bare)
  }

  if (!bare.includes(".")) {
    return true
  }

  return LOCAL_SUFFIXES.some((suffix) => bare.endsWith(suffix))
}

/**
 * True for an http(s) origin or URL whose host is local; false for anything
 * else, malformed included.
 */
export function isLocalAddress(address: string): boolean {
  let url: URL

  try {
    url = new URL(address)
  } catch {
    return false
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false
  }

  return isLocalHostname(url.hostname)
}
