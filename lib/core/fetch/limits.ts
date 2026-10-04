/**
 * Bounds on what web_fetch makes PCP do. The address, the headers and the
 * body come from an assistant, and the answer from whatever site it named:
 * nothing about one fetch may cost more than these.
 */

/** One fetch, every redirect included. */
export const FETCH_TIMEOUT_MS = 30_000
/** Redirects followed within a site; one to another site is never followed. */
export const MAX_FETCH_REDIRECTS = 5
export const MAX_FETCH_URL_LENGTH = 8192
export const MAX_FETCH_HEADERS = 20
export const MAX_FETCH_BODY_BYTES = 1024 * 1024
/** What is read of an answer; the rest is left unread. */
export const MAX_FETCH_RESPONSE_BYTES = 2 * 1024 * 1024
/** Characters handed back per call when the assistant does not say. */
export const DEFAULT_FETCH_LENGTH = 20_000
/**
 * The most characters one call hands back. Under the gateway's 60,000 for a
 * result, so the lines in front of the text are never what gets cut.
 */
export const MAX_FETCH_LENGTH = 50_000
/** Method and site levels kept per vault, for all tokens together. */
export const MAX_FETCH_RULES = 1000
/** A site as the owner types it. */
export const MAX_SITE_LENGTH = 300
/** A page's title as it goes in front of the text. */
export const MAX_TITLE_CHARS = 300
/** How much of an HTML page is searched for a <meta charset>. */
export const CHARSET_SNIFF_BYTES = 2048

export const FETCH_ACCEPT =
  "text/html, application/xhtml+xml, application/json;q=0.9, text/plain;q=0.9, */*;q=0.8"
