import dns from "node:dns"
import { isIP } from "node:net"

import { invalid } from "../errors"
import { bareHostname, isPublicAddress } from "../openapi/address"
import type { SendOptions } from "../openapi/transport"

/**
 * The addresses a mail account has: a JMAP session URL, an IMAP server and
 * an SMTP server. All are the owner's to type, and none may carry a user
 * name or password (those belong in a secret). Mail never goes in the
 * clear: imap:// and smtp:// mean STARTTLS, which PCP insists on, and a JMAP
 * session URL is https:// unless the server is on the owner's own network
 * (a private, loopback or link-local address, or a name that resolves only
 * to those).
 */

export type MailServerAddress = {
  host: string
  port: number
  /** TLS from the first byte (imaps, smtps); otherwise STARTTLS. */
  secure: boolean
}

/** Why a session URL over http:// was refused. */
export const PLAIN_HTTP_REFUSED =
  "The session URL uses http://, which sends the sign-in unencrypted. PCP allows that only for a server on your own network (a private, loopback or link-local address, or a name that resolves only to those). Use an https:// session URL."

/** A private, loopback or link-local IP address; false for a name. */
function isPrivateAddress(address: string): boolean {
  return (
    isIP(address.replace(/^\[|\]$/g, "")) !== 0 && !isPublicAddress(address)
  )
}

/**
 * How a request to a mail server is sent: over http:// only to a private
 * address, checked on the address the socket connects to, so a name that
 * answers with a public one to a check and a private one to the connection
 * cannot get through. https:// goes as it always did.
 */
export function mailSendOptions(
  url: string,
): Pick<SendOptions, "publicOnly" | "addressCheck"> {
  return new URL(url).protocol === "http:"
    ? { publicOnly: true, addressCheck: (address) => isPrivateAddress(address) }
    : {}
}

export function validateSessionUrl(raw: string): string {
  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    throw invalid(
      "Enter the JMAP session URL, like https://mail.example.com/.well-known/jmap.",
    )
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid(
      "The session URL must start with https:// (or http:// on your own network).",
    )
  }

  // An IP address needs no lookup. A name is looked up in
  // requireEncryptedOrPrivate, which every place that takes a URL calls.
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
    throw invalid("The session URL cannot have a query or a fragment.")
  }

  return url.toString()
}

export type HostLookup = (host: string) => Promise<string[]>

const lookupAll: HostLookup = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address)

/**
 * Refuses an http:// session URL whose name does not resolve only to
 * private, loopback or link-local addresses. A URL that passed
 * validateSessionUrl is https:// or an IP address already; this is the
 * lookup for a name. The connection checks again (mailSendOptions), because
 * a name can answer differently later.
 */
export async function requireEncryptedOrPrivate(
  sessionUrl: string,
  lookup: HostLookup = lookupAll,
): Promise<void> {
  const url = new URL(sessionUrl)

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
 * A JMAP session URL as an assistant may name it: the full address, the
 * server's origin (https://mail.example.com), or a bare host name. A server
 * with no path gets the well-known one, which RFC 8620 puts the session at.
 */
export function completeSessionUrl(raw: string): string {
  const trimmed = raw.trim()
  const url = new URL(
    validateSessionUrl(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || !trimmed
        ? trimmed
        : `https://${trimmed}`,
    ),
  )

  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/.well-known/jmap"
  }

  return url.toString()
}

const SCHEMES = {
  imap: {
    secure: "imaps:",
    starttls: "imap:",
    securePort: 993,
    starttlsPort: 143,
  },
  smtp: {
    secure: "smtps:",
    starttls: "smtp:",
    securePort: 465,
    starttlsPort: 587,
  },
} as const

function parseMailServer(
  raw: string,
  protocol: keyof typeof SCHEMES,
): MailServerAddress {
  const schemes = SCHEMES[protocol]
  const trimmed = raw.trim()
  const example = `${schemes.secure}//mail.example.com:${schemes.securePort}`

  if (!trimmed) {
    throw invalid(
      `Enter the ${protocol.toUpperCase()} server, like ${example}.`,
    )
  }

  // A bare host name means TLS on the usual port.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${schemes.secure}//${trimmed}`
  let url: URL

  try {
    url = new URL(withScheme)
  } catch {
    throw invalid(
      `Enter the ${protocol.toUpperCase()} server, like ${example}.`,
    )
  }

  const secure = url.protocol === schemes.secure

  if (!secure && url.protocol !== schemes.starttls) {
    throw invalid(
      `The ${protocol.toUpperCase()} server's address starts with ${schemes.secure}// (or ${schemes.starttls}// for STARTTLS).`,
    )
  }

  if (url.username || url.password) {
    throw invalid(
      "The address cannot contain a user name or password; keep credentials in a secret.",
    )
  }

  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw invalid(
      `The ${protocol.toUpperCase()} server's address is a host and a port, nothing after them.`,
    )
  }

  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")

  if (!host) {
    throw invalid(
      `Enter the ${protocol.toUpperCase()} server, like ${example}.`,
    )
  }

  return {
    host,
    port: url.port
      ? Number(url.port)
      : secure
        ? schemes.securePort
        : schemes.starttlsPort,
    secure,
  }
}

export function parseImapAddress(raw: string): MailServerAddress {
  return parseMailServer(raw, "imap")
}

export function parseSmtpAddress(raw: string): MailServerAddress {
  return parseMailServer(raw, "smtp")
}

/** The address as PCP stores and shows it, with its port spelled out. */
export function formatMailServer(
  protocol: "imap" | "smtp",
  address: MailServerAddress,
): string {
  const scheme = address.secure
    ? SCHEMES[protocol].secure
    : SCHEMES[protocol].starttls
  const host = address.host.includes(":") ? `[${address.host}]` : address.host

  return `${scheme}//${host}:${address.port}`
}

/**
 * An address a server named (a JMAP session's apiUrl), resolved against
 * the one the owner typed, and accepted only on the same origin: the
 * credential goes nowhere the owner did not choose. Null otherwise.
 */
export function onSameOrigin(named: string, typed: string): string | null {
  try {
    const base = new URL(typed)
    const url = new URL(named, base)

    if (url.origin !== base.origin || url.username || url.password) {
      return null
    }

    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

/**
 * A finished address, parsed with no base, accepted only when it is absolute
 * and on the typed origin; the string returned is the one to fetch. Parsing
 * it the way fetch will is the point: a form like "https:host/x" resolves
 * against a base as a path on it, and alone as another host. Null otherwise.
 */
export function onSameOriginAbsolute(
  named: string,
  typed: string,
): string | null {
  try {
    const url = new URL(named)

    if (url.origin !== new URL(typed).origin || url.username || url.password) {
      return null
    }

    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/

/**
 * One recipient as an assistant writes it: "ada@example.com" or
 * "Ada Lovelace <ada@example.com>". Nothing that could start a header of
 * its own gets through. A refusal names the address by `where` ("Recipient 2
 * in to"), never by its text: the request log keeps these messages, and not
 * what an assistant sent.
 */
export function parseRecipient(
  raw: string,
  where = "The address",
): {
  name: string | null
  email: string
} {
  const value = raw.trim()

  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${where} cannot have line breaks or control characters.`)
  }

  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value)
  const email = (named ? named[2]! : value).trim()
  const name = named ? named[1]!.trim().replace(/^"(.*)"$/, "$1") || null : null

  if (!ADDRESS.test(email) || email.length > 320) {
    throw invalid(`${where} is not an email address.`)
  }

  if (name && (name.length > 200 || /[<>"]/.test(name))) {
    throw invalid(
      `The name in ${where.toLowerCase()} cannot have <, > or quotes, and is at most 200 characters.`,
    )
  }

  return { name, email }
}
