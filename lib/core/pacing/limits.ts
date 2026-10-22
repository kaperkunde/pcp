/**
 * How fast PCP lets assistants act on one place (lib/core/pacing/): a pause
 * between actions with a random extra wait, so a run of automated actions
 * looks like a person at work rather than a script, and a cap on how many
 * go out in a stretch of time. Sites flag accounts that act in rapid fire,
 * and a busy page or a small server can be overloaded by it.
 *
 * Pacing applies per destination: a server (by its id) for every call that
 * goes to an MCP server, an API endpoint, a mail or calendar account or an
 * SSH server, and a site (a host) for web fetch's requests and for the
 * browser's actions. Nothing here names a site or a vendor: what differs is
 * the class of action, and the owner's own overrides (Settings → Pacing, a
 * server's Advanced).
 */

/** At most `max` actions in any `perMs` milliseconds. */
export type PacingBurst = { max: number; perMs: number }

export type PacingPolicy = {
  /** The pause after one action before the next may go. */
  minIntervalMs: number
  /** Up to this much more, picked at random for each pause. */
  jitterMs: number
  /** Null: no cap beyond the pause. */
  burst: PacingBurst | null
}

/** An owner's override: a pace of their own, or none at all. */
export type PacingOverride = PacingPolicy | "unpaced"

export const PACING_CLASSES = [
  "browser_act",
  "web_fetch",
  "server_change",
  "server_read",
] as const

export type PacingClass = (typeof PACING_CLASSES)[number]

const MINUTE = 60_000

/**
 * PCP's defaults, by class of action. Each is the safe side for most places
 * an assistant reaches; the owner can move them.
 */
export const PACING_DEFAULTS: Record<PacingClass, PacingPolicy> = {
  /**
   * The browser acting on a page: navigate, back, click, type, press_key,
   * select_option, upload_file, download, handle_dialog and scroll (which
   * makes a page load more, as long lists do). This is where a site sees
   * a visitor's behaviour most closely, so a pause of a person's length:
   * one and a half seconds, and up to two and a half more at random. The
   * pause caps how many go out, so no burst limit on top.
   */
  browser_act: { minIntervalMs: 1_500, jitterMs: 2_500, burst: null },
  /**
   * Web fetch's requests, every redirect it follows on a site and the read
   * through the browser included: a second between requests, with a little
   * at random. A request is one page, not a person's click, so shorter
   * than the browser's.
   */
  web_fetch: { minIntervalMs: 1_000, jitterMs: 750, burst: null },
  /**
   * A server's tools that change something (any its server does not mark
   * read-only). Servers are APIs, made for programs, so no pause between
   * calls; but at most 30 a minute, so a program that loops cannot send
   * a flood of changes before anyone notices.
   */
  server_change: {
    minIntervalMs: 0,
    jitterMs: 0,
    burst: { max: 30, perMs: MINUTE },
  },
  /**
   * A server's read-only tools: only a generous cap, five a second on
   * average over a minute, well past what one run_code program makes
   * (code/limits.ts MAX_CALLS_PER_RUN) and enough to spare a small server.
   */
  server_read: {
    minIntervalMs: 0,
    jitterMs: 0,
    burst: { max: 300, perMs: MINUTE },
  },
}

/**
 * Browser tools that are never paced: they read the page the tab already
 * has (or wait on it, or list tabs) and send the site nothing it would not
 * get anyway. `tabs` opening a page is a navigation, paced as one; the
 * owner's hand_over is theirs.
 */
export const UNPACED_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "snapshot",
  "find",
  "read_page",
  "screenshot",
  "wait_for",
  "tabs",
  "hand_over",
])

/**
 * The longest a call waits for its turn. A wait is served, not refused, up
 * to this; past it the call is answered at once with when the destination
 * takes its next action, so nothing holds a client for minutes.
 */
export const PACING_MAX_WAIT_MS = 30_000

/** What the owner may set, per field. */
export const PACING_BOUNDS = {
  minIntervalMs: { min: 0, max: 10 * MINUTE },
  jitterMs: { min: 0, max: 10 * MINUTE },
  burstMax: { min: 1, max: 10_000 },
  burstPerMs: { min: 1_000, max: 24 * 60 * MINUTE },
} as const

/** Sites with a pace of their own, per vault. */
export const MAX_PACED_SITES = 200
/** Servers with a pace of their own, per vault. */
export const MAX_PACED_SERVERS = 500

/**
 * Destinations whose state is held in memory, for every vault together.
 * Past it the one used longest ago is dropped, which only gives that one a
 * fresh start.
 */
export const MAX_PACED_DESTINATIONS = 10_000

/**
 * How long a destination's state outlives its last action, and so the
 * longest burst window that counts anything (the bound on `perMs`).
 */
export const PACING_STATE_TTL_MS = PACING_BOUNDS.burstPerMs.max

/**
 * PCP_PACING=off turns pacing off for the whole process. It is for test
 * suites (vitest.config.mts, playwright.config.ts), which act far faster
 * than a person and would otherwise wait on every action; it is read on
 * each call, so a test can turn it back on.
 */
export function pacingOff(): boolean {
  return process.env.PCP_PACING?.trim().toLowerCase() === "off"
}
