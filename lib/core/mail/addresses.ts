import { invalid } from "../errors"

/**
 * The addresses a mail account has: a JMAP session URL, an IMAP server and
 * an SMTP server. All are the owner's to type, and none may carry a user
 * name or password (those belong in a secret). Mail never goes in the
 * clear: imap:// and smtp:// mean STARTTLS, which PCP insists on.
 */

export type MailServerAddress = {
  host: string
  port: number
  /** TLS from the first byte (imaps, smtps); otherwise STARTTLS. */
  secure: boolean
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
      "The session URL must start with https:// (or http:// on a private network).",
    )
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

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/

/**
 * One recipient as an assistant writes it: "ada@example.com" or
 * "Ada Lovelace <ada@example.com>". Nothing that could start a header of
 * its own gets through.
 */
export function parseRecipient(raw: string): {
  name: string | null
  email: string
} {
  const value = raw.trim()

  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid("An address cannot have line breaks or control characters.")
  }

  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value)
  const email = (named ? named[2]! : value).trim()
  const name = named ? named[1]!.trim().replace(/^"(.*)"$/, "$1") || null : null

  if (!ADDRESS.test(email) || email.length > 320) {
    throw invalid(`${raw.slice(0, 100)} is not an email address.`)
  }

  if (name && (name.length > 200 || /[<>"]/.test(name))) {
    throw invalid(
      `The name in ${raw.slice(0, 100)} cannot have <, > or quotes.`,
    )
  }

  return { name, email }
}
