// A copy of tunnel/protocol/http-head.ts in kaperkunde/pcp-gg: only the relay
// (relay.ts) uses it.

import { normalizeServerName } from "./sni"

/**
 * The start of a plain-HTTP request on port 80, read only far enough to
 * know the name and path. The relay answers port 80 itself with a redirect
 * to HTTPS; the one thing it passes on is Let's Encrypt's challenge, which
 * PCP answers to prove it holds the name.
 */

export type HttpHead =
  | { status: "more" }
  | { status: "invalid"; reason: string }
  | { status: "done"; method: string; target: string; host: string | null }

const HEAD_END = "\r\n\r\n"

export function parseHttpHead(data: Uint8Array): HttpHead {
  const text = Buffer.from(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).toString("latin1")
  const end = text.indexOf(HEAD_END)

  if (end === -1) {
    return /^[A-Z]{0,10}$/.test(text.slice(0, 10).split(" ")[0] ?? "")
      ? { status: "more" }
      : { status: "invalid", reason: "not HTTP" }
  }

  const [requestLine = "", ...headerLines] = text.slice(0, end).split("\r\n")
  const match = /^([A-Z]{1,10}) (\S{1,4096}) HTTP\/1\.[01]$/.exec(requestLine)

  if (!match) {
    return { status: "invalid", reason: "bad request line" }
  }

  let host: string | null = null

  for (const line of headerLines) {
    const colon = line.indexOf(":")

    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "host") {
      host = normalizeServerName(
        line
          .slice(colon + 1)
          .trim()
          .replace(/:\d+$/, ""),
      )
      break
    }
  }

  return { status: "done", method: match[1]!, target: match[2]!, host }
}

export const ACME_CHALLENGE_PREFIX = "/.well-known/acme-challenge/"

/** Let's Encrypt's tokens are base64url; anything else is not a challenge. */
export function isAcmeChallenge(method: string, target: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    target.startsWith(ACME_CHALLENGE_PREFIX) &&
    /^[A-Za-z0-9_-]{1,256}$/.test(target.slice(ACME_CHALLENGE_PREFIX.length))
  )
}

export function httpResponse(
  status: number,
  reason: string,
  headers: Record<string, string> = {},
  body = "",
): string {
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    ...Object.entries({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      Connection: "close",
      ...headers,
    }).map(([name, value]) => `${name}: ${value}`),
  ]
  return `${lines.join("\r\n")}\r\n\r\n${body}`
}
