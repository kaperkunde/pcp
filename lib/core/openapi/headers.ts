/**
 * Headers an argument may never set. PCP sets some of them itself (the
 * credential, content type, accept); the rest would let a request smuggle
 * a second one, reach another virtual host, or ride on a cookie.
 */

const BLOCKED = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  // They change what the server thinks the request is, or who sent it.
  "forwarded",
  "origin",
  "referer",
  "via",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
  "x-real-ip",
])

/** RFC 9110 token characters: what a header name may contain. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

export function isBlockedHeader(name: string, extra: string[] = []): boolean {
  const lower = name.toLowerCase()

  return (
    !TOKEN.test(name) ||
    BLOCKED.has(lower) ||
    lower.startsWith("proxy-") ||
    lower.startsWith("sec-") ||
    lower.startsWith("x-forwarded-") ||
    extra.some((header) => header.toLowerCase() === lower)
  )
}
