import { isIP } from "node:net"

import { invalid } from "../errors"
import {
  bareHostname,
  isPublicAddress,
  lookupAll,
  type HostLookup,
} from "../openapi/address"
import type { SendOptions } from "../openapi/transport"

/**
 * The addresses a calendar account has: the CalDAV server the owner typed
 * (or an assistant proposed), and the calendar home the server names under
 * it. The sign-in goes to the typed origin, and to a home elsewhere only
 * over https:// on a host of the same domain, the way iCloud answers at
 * caldav.icloud.com and keeps each account's calendars on
 * p<n>-caldav.icloud.com. Never in the clear across the internet: http:// is
 * only for a server on the owner's own network.
 */

export const PLAIN_HTTP_REFUSED =
  "The CalDAV address uses http://, which sends the sign-in unencrypted. PCP allows that only for a server on your own network (a private, loopback or link-local address, or a name that resolves only to those). Use an https:// address."

function isPrivateAddress(address: string): boolean {
  return (
    isIP(address.replace(/^\[|\]$/g, "")) !== 0 && !isPublicAddress(address)
  )
}

/**
 * The server's address as the owner or an assistant gives it: a full URL, or
 * a bare host name, which means https:// and the root, where a CalDAV server
 * is found (RFC 6764: /.well-known/caldav answers there too).
 */
export function validateCalDavUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL

  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || !trimmed
        ? trimmed
        : `https://${trimmed}`,
    )
  } catch {
    throw invalid(
      "Enter the CalDAV server's address, like https://caldav.icloud.com.",
    )
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid(
      "The CalDAV address must start with https:// (or http:// on your own network).",
    )
  }

  if (url.protocol === "http:") {
    const host = bareHostname(url)

    if (isIP(host) !== 0 && !isPrivateAddress(host)) {
      throw invalid(PLAIN_HTTP_REFUSED)
    }
  }

  if (url.username || url.password) {
    throw invalid(
      "The address cannot contain a user name or password; keep credentials in a secret.",
    )
  }

  if (url.search || url.hash) {
    throw invalid("The CalDAV address cannot have a query or a fragment.")
  }

  return url.toString()
}

/**
 * Refuses an http:// address whose name does not resolve only to private,
 * loopback or link-local addresses. The connection checks again
 * (davSendOptions), because a name can answer differently later.
 */
export async function requireEncryptedOrPrivate(
  address: string,
  lookup: HostLookup = lookupAll,
): Promise<void> {
  const url = new URL(address)

  if (url.protocol !== "http:") {
    return
  }

  const host = bareHostname(url)

  if (isIP(host) !== 0) {
    if (!isPrivateAddress(host)) {
      throw invalid(PLAIN_HTTP_REFUSED)
    }

    return
  }

  let addresses: string[]

  try {
    addresses = await lookup(host)
  } catch {
    addresses = []
  }

  if (addresses.length === 0 || !addresses.every(isPrivateAddress)) {
    throw invalid(PLAIN_HTTP_REFUSED)
  }
}

/**
 * How a request is sent: http:// only to a private address, checked on the
 * address the socket connects to; a home on another host (`elsewhere`) to
 * public addresses only, so a server cannot point PCP's sign-in at the
 * owner's network.
 */
export function davSendOptions(
  url: string,
  { elsewhere = false }: { elsewhere?: boolean } = {},
): Pick<SendOptions, "publicOnly" | "addressCheck"> {
  if (new URL(url).protocol === "http:") {
    return {
      publicOnly: true,
      addressCheck: (address) => isPrivateAddress(address),
    }
  }

  return elsewhere ? { publicOnly: true } : {}
}

/** The domain a host belongs to for the home rule: it without its first label. */
function parentDomain(host: string): string | null {
  if (isIP(host) !== 0) {
    return null
  }

  const labels = host.toLowerCase().replace(/\.$/, "").split(".")

  // caldav.icloud.com → icloud.com; never a bare top-level domain, and
  // never a two-letter second level under a country (example.co.uk's
  // parent is example.co.uk itself, not co.uk).
  if (labels.length < 3) {
    return null
  }

  const parent = labels.slice(1)

  if (
    parent.length === 2 &&
    parent[0]!.length <= 3 &&
    parent[1]!.length === 2
  ) {
    return null
  }

  return parent.join(".")
}

/**
 * An address the server named (the principal, the calendar home, an
 * object's href), resolved against the address it answered at, and accepted
 * only on the typed origin, or over https:// on a host under the typed
 * host's own domain. Null otherwise: the credential goes nowhere else.
 */
export function acceptedAddress(
  named: string,
  base: string,
  typed: string,
): string | null {
  let url: URL
  let origin: URL

  try {
    url = new URL(named, base)
    origin = new URL(typed)
  } catch {
    return null
  }

  if (url.username || url.password) {
    return null
  }

  url.hash = ""

  if (url.origin === origin.origin) {
    return url.toString()
  }

  const parent = parentDomain(bareHostname(origin))
  const host = bareHostname(url).toLowerCase()

  if (
    url.protocol === "https:" &&
    parent !== null &&
    isIP(host) === 0 &&
    host.endsWith(`.${parent}`)
  ) {
    return url.toString()
  }

  return null
}

/** Whether an address is somewhere other than the typed origin. */
export function isElsewhere(address: string, typed: string): boolean {
  return new URL(address).origin !== new URL(typed).origin
}
