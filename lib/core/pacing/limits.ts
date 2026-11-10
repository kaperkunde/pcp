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
  "browser_navigate",
  "web_fetch",
  "server_change",
  "server_read",
] as const

export type PacingClass = (typeof PACING_CLASSES)[number]

/** The browser's classes: what a tab's or a wrapper's own pace may set. */
export const BROWSER_PACING_CLASSES = [
  "browser_act",
  "browser_navigate",
] as const

export type BrowserPacingClass = (typeof BROWSER_PACING_CLASSES)[number]

const MINUTE = 60_000

/**
 * PCP's defaults, by class of action. Each is the safe side for most places
 * an assistant reaches; the owner can move them.
 */
export const PACING_DEFAULTS: Record<PacingClass, PacingPolicy> = {
  /**
   * The browser acting in a page: click, drag, type, press_key,
   * select_option, upload_file, download by a click, handle_dialog,
   * evaluate and scroll (which makes a page load more, as long
   * lists do). A person moves from one field or button to the next in a
   * few hundred milliseconds, so that: 150 ms, and up to 450 more at
   * random, after the previous action on the site ended. type fills a
   * field in one go, so there is no pause per key. The pause caps how many
   * go out, so no burst limit on top.
   */
  browser_act: { minIntervalMs: 150, jitterMs: 450, burst: null },
  /**
   * The browser opening a page: navigate, back, tabs opening one, and
   * download by an address. It first waits for the page the tab shows to
   * settle (loaded, a site's check passed: browser/call.ts settle), not for
   * a fixed time, then 400 ms and up to 800 more at random, as a person
   * glances at a page before they leave it.
   */
  browser_navigate: { minIntervalMs: 400, jitterMs: 800, burst: null },
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

/** Browser tools that open a page, paced as browser_navigate. */
const NAVIGATING_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "navigate",
  "back",
])

/**
 * The class a browser tool is paced as, null for one that is never paced:
 * a page opened (navigate, back, tabs open, download by its address) is a
 * navigation; anything else done in a page is an action. tabs' other
 * actions read or close tabs, and send a site nothing.
 */
export function browserPacingClass(
  toolName: string,
  args: Record<string, unknown> = {},
): BrowserPacingClass | null {
  if (toolName === "tabs") {
    return args.action === "open" ? "browser_navigate" : null
  }

  if (UNPACED_BROWSER_TOOLS.has(toolName)) {
    return null
  }

  return NAVIGATING_BROWSER_TOOLS.has(toolName) ||
    (toolName === "download" && typeof args.url === "string")
    ? "browser_navigate"
    : "browser_act"
}

/**
 * A pace an assistant gives a tab, or a wrapper for its calls: a wait
 * between `minMs` and `maxMs` after the previous action, picked at random.
 */
export type PaceRange = { minMs: number; maxMs: number }

/** A pace of a tab's or a wrapper's own, per class, as an assistant names it. */
export type BrowserPace = {
  /** browser_act: what is done in a page. */
  actions?: PaceRange
  /** browser_navigate: a page opened. */
  navigations?: PaceRange
}

/**
 * A wrapper's pace for the browser calls its tools make, part of its
 * definition: per kind of action, and per browser tool (by its name), the
 * tool's own first.
 */
export type WrapperPace = BrowserPace & { tools?: Record<string, PaceRange> }

/** The most browser tools a wrapper's pace names. */
export const MAX_WRAPPER_PACE_TOOLS = 30

/** BrowserPace's keys, by class. */
export const PACE_KEY_OF: Record<BrowserPacingClass, keyof BrowserPace> = {
  browser_act: "actions",
  browser_navigate: "navigations",
}

/**
 * What an assistant may give a tab, or a wrapper, without asking the owner,
 * per class, unless the owner set bounds of their own (Settings → Pacing,
 * the vault's `pacing` setting's `assistant`): from a third of PCP's
 * default down to a few times it up. Faster or slower asks the owner (a
 * tab: a tab_pace request; a wrapper: its wrapper_change page says so).
 */
export const ASSISTANT_PACE_BOUNDS: Record<BrowserPacingClass, PaceRange> = {
  browser_act: { minMs: 50, maxMs: 5_000 },
  browser_navigate: { minMs: 150, maxMs: 10_000 },
}

/**
 * The most any of these ranges goes to, the owner's bounds included: a
 * call that waits longer than PACING_MAX_WAIT_MS between actions is
 * answered "Paced" rather than served.
 */
export const MAX_ASSISTANT_PACE_MS = 30_000

/** A range as the policy it stands for: the low end, and the rest at random. */
export function rangePolicy(range: PaceRange): PacingPolicy {
  return {
    minIntervalMs: range.minMs,
    jitterMs: Math.max(0, range.maxMs - range.minMs),
    burst: null,
  }
}

/**
 * Browser tools that are never paced: they read the page the tab already
 * has (or wait on it, or list tabs) and send the site nothing it would not
 * get anyway. `tabs` opening a page is a navigation, paced as one; the
 * owner's hand_over is theirs, and request_secret and update_secret_sites
 * ask only the owner.
 */
export const UNPACED_BROWSER_TOOLS: ReadonlySet<string> = new Set<string>([
  "snapshot",
  "find",
  "read_page",
  "screenshot",
  "print_pdf",
  "console_log",
  "network_log",
  "wait_for",
  "tabs",
  "hand_over",
  "request_secret",
  "update_secret_sites",
])

/**
 * How long a call waits for its turn when its caller names no deadline. A
 * wait is served, not refused, up to its budget; past it the call is
 * answered at once with when the destination takes its next action, and
 * nothing is sent.
 */
export const PACING_MAX_WAIT_MS = 30_000

/**
 * The budget of a call made straight from an assistant's request:
 * call_tool_<tier>, web_fetch, and a call the owner
 * allowed. The same clock as run_code's RUN_ANSWER_MS (code/limits.ts):
 * under the minute after which clients give up, with time left for the
 * call itself.
 */
export const PACING_CALL_WAIT_MS = 45_000

/**
 * What a caller's deadline leaves the call itself once its turn comes: a
 * run_code program's call waits until this long before the run's end, so
 * the call has time to run and answer.
 */
export const PACING_DEADLINE_MARGIN_MS = 5_000

/**
 * The longest any call waits for its turn, whatever its deadline: as long
 * as a run_code run may take (code/limits.ts RUN_TIMEOUT_MS).
 */
export const PACING_LONGEST_WAIT_MS = 3 * MINUTE

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
