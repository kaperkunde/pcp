/**
 * A site's check of its visitors: the page Cloudflare answers with instead
 * of the one asked for ("Just a moment…", Turnstile), until the visitor's
 * browser has shown it is one. Cloudflare marks every such answer with the
 * header `cf-mitigated: challenge`, whatever the status (usually 403 or
 * 503) and whatever kind of check it is, so that header is how PCP tells
 * one: never the page's text, which a site can write as it likes.
 *
 * web_fetch (fetch.ts) cannot pass such a check: it runs no page script. The
 * vault's browser can (browser/challenge.ts, browser/solve.ts).
 */

export const CHALLENGE_HEADER = "cf-mitigated"

/** Whether an answer is a site's check rather than the page. */
export function isChallenge(
  headers: Headers | Record<string, string | string[] | undefined>,
): boolean {
  const value =
    headers instanceof Headers
      ? headers.get(CHALLENGE_HEADER)
      : headers[CHALLENGE_HEADER]
  const first = Array.isArray(value) ? value[0] : value

  return first?.trim().toLowerCase() === "challenge"
}

/** The sentence every answer that met a check starts with. */
export const CHALLENGE_LINE =
  "Cloudflare is asking this site's visitors to prove they are human before it shows the page."
