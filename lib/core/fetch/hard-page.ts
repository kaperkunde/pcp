/**
 * Whether a page web_fetch read looks hard to read as text (#178): a page
 * built by scripts has little text, and its links, downloads and buttons are
 * not in what a fetch sees. Pure, and a guess only: all it leads to is one
 * line telling an assistant that has PCP's browser to try it there.
 */

/** The line an assistant is told, with the browser server's short name. */
export const hardPageHint = (browserSlug: string) =>
  `Hard to read this page? Open it with ${browserSlug}/navigate and read its snapshot (links show their /url).`

/** Text shorter than this, from a page this large, is near-empty. */
export const NEAR_EMPTY_TEXT_CHARS = 200
const NEAR_EMPTY_MIN_HTML_BYTES = 2_000
/** Script bytes that outweigh the text this many times, from this many up. */
const SCRIPT_TO_TEXT_RATIO = 20
const SCRIPT_MIN_BYTES = 30_000
/** What a page that sends downloads and buttons to a script talks about. */
const ACTION_WORDS = /\b(download|brochure|brochures|pdf|button)\b/i
/** Several fetches of one site in a short while: the page is not giving. */
export const REPEAT_FETCHES = 3
export const REPEAT_WINDOW_MS = 5 * 60_000

export type HardPageReason =
  "near_empty" | "script_heavy" | "actions_without_links"

/** The bytes inside <script> elements of an HTML text. */
export function scriptBytes(html: string): number {
  let total = 0

  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    total += match[1]?.length ?? 0
  }

  return total
}

/**
 * Why a page reads as hard, or null. `html` is what came, `markdown` what
 * web_fetch turned it into.
 */
export function hardPageReason(
  html: string,
  markdown: string,
): HardPageReason | null {
  const text = markdown.trim()
  const scripts = scriptBytes(html)

  if (
    text.length < NEAR_EMPTY_TEXT_CHARS &&
    html.length >= NEAR_EMPTY_MIN_HTML_BYTES
  ) {
    return "near_empty"
  }

  if (
    scripts >= SCRIPT_MIN_BYTES &&
    scripts > SCRIPT_TO_TEXT_RATIO * Math.max(text.length, 1)
  ) {
    return "script_heavy"
  }

  // Words of an action, and not one link address in the text.
  if (ACTION_WORDS.test(text) && !/\]\([^)\s]+\)/.test(text)) {
    return "actions_without_links"
  }

  return null
}

const MAX_REMEMBERED_SITES = 500
const visits = new Map<string, number[]>()

/**
 * Notes a fetch of a site by a token (in memory, bounded) and says whether
 * it is the REPEAT_FETCHES-th within the window.
 */
export function noteSiteFetch(
  tokenId: string,
  host: string,
  now = Date.now(),
): boolean {
  const key = `${tokenId}\n${host}`
  const recent = (visits.get(key) ?? []).filter(
    (at) => now - at < REPEAT_WINDOW_MS,
  )

  recent.push(now)

  if (!visits.has(key) && visits.size >= MAX_REMEMBERED_SITES) {
    visits.clear()
  }
  visits.set(key, recent.slice(-REPEAT_FETCHES))

  return recent.length >= REPEAT_FETCHES
}

/** For tests. */
export function resetSiteFetches(): void {
  visits.clear()
}
