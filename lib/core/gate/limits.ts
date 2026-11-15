/**
 * The call gate's limits (lib/core/gate/): how many calls may run at once
 * at one place, how far apart they go, how many a minute, how long one may
 * take, how many bytes a day may come back, and how long a place that
 * asked PCP to slow down is left to cool down.
 *
 * A place is a server (every kind PCP calls: an MCP server, an API
 * endpoint, a mail or calendar account, an SSH server, a service, a storage
 * folder) or a site (the browser's and web fetch's, by host). Nothing here
 * names a site or a vendor: the defaults are per class of place, the safe
 * side for most of them, and the owner sets a server's own on its page.
 *
 * Spacing and calls a minute are pacing's (lib/core/pacing/): the gate
 * hands its numbers to pacing as a floor under the class's pace, so there
 * is one spacing, not two.
 */

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

export const GATE_CLASSES = [
  "mcp",
  "endpoint",
  "mail",
  "calendar",
  "ssh",
  "service",
  "storage",
  "browser_site",
  "web_fetch_site",
] as const

export type GateClass = (typeof GATE_CLASSES)[number]

export type GateLimits = {
  /** Calls running at once; more wait their turn, within their own time. */
  maxConcurrent: number
  /** The least time between one call's start and the next one's. */
  minIntervalMs: number
  /** At most this many calls in any minute; null: no cap of its own. */
  callsPerMinute: number | null
  /**
   * How long PCP waits for one call before it answers `timeout`; what was
   * asked may still finish at the place.
   */
  timeoutMs: number
  /** At most this many bytes of answers in a day; null: no cap. */
  bytesPerDay: number | null
  /** The first cool-down when a place asks PCP to slow down. */
  backoffBaseMs: number
  /** The longest one, however often it asks again. */
  backoffMaxMs: number
}

const BACKOFF = { backoffBaseMs: 30 * SECOND, backoffMaxMs: 15 * MINUTE }

/**
 * PCP's defaults, per class. The time limits are each kind's own from
 * before the gate (an MCP call's 2 minutes, an API's minute), but for mail,
 * which had none: an IMAP command could hang until its connection's idle
 * timeout, so a mail call now gives up after 45 seconds. A mail account
 * takes two calls at once, a little apart, as mail servers count
 * connections per account; an SSH command and a storage folder's transfer
 * take as long as their own limits allow.
 */
export const GATE_DEFAULTS: Record<GateClass, GateLimits> = {
  mcp: {
    maxConcurrent: 8,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: 2 * MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  endpoint: {
    maxConcurrent: 8,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  mail: {
    maxConcurrent: 2,
    minIntervalMs: 250,
    callsPerMinute: null,
    timeoutMs: 45 * SECOND,
    bytesPerDay: null,
    ...BACKOFF,
  },
  calendar: {
    maxConcurrent: 4,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  ssh: {
    maxConcurrent: 4,
    minIntervalMs: 0,
    callsPerMinute: null,
    // run_command's own timeout goes up to 10 minutes (ssh/limits.ts).
    timeoutMs: 11 * MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  service: {
    maxConcurrent: 4,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: 5 * MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  storage: {
    maxConcurrent: 4,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: 10 * MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  // The browser's and web fetch's own time limits apply (timeout_ms, and
  // fetch/limits.ts): the gate adds cooling down and counting per site.
  browser_site: {
    maxConcurrent: 4,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: 2 * MINUTE,
    bytesPerDay: null,
    ...BACKOFF,
  },
  web_fetch_site: {
    maxConcurrent: 4,
    minIntervalMs: 0,
    callsPerMinute: null,
    timeoutMs: 30 * SECOND,
    bytesPerDay: null,
    ...BACKOFF,
  },
}

/** The class of a server's kind; null for one the gate leaves alone. */
export function gateClassOf(kind: string): GateClass | null {
  switch (kind) {
    case "mcp":
      return "mcp"
    case "openapi":
      return "endpoint"
    case "jmap":
    case "imap":
      return "mail"
    case "caldav":
      return "calendar"
    case "ssh":
      return "ssh"
    case "service":
      return "service"
    case "storage":
      return "storage"
    // The browser is gated per site (browser/call.ts); a wrapper's tool by
    // the calls its program makes.
    default:
      return null
  }
}

/**
 * What a server's limits may be set to, whoever proposes them: the
 * machine's own safety bounds, not a judgement of what a place allows.
 */
export const GATE_BOUNDS = {
  maxConcurrent: { min: 1, max: 32 },
  minIntervalMs: { min: 0, max: 10 * MINUTE },
  callsPerMinute: { min: 1, max: 10_000 },
  timeoutMs: { min: SECOND, max: 30 * MINUTE },
  bytesPerDay: { min: 1_024, max: 1024 ** 4 },
  backoffBaseMs: { min: SECOND, max: HOUR },
  backoffMaxMs: { min: SECOND, max: 24 * HOUR },
} as const satisfies Record<keyof GateLimits, { min: number; max: number }>

/**
 * Throttle detection by latency, per server and tool: a tool whose answers
 * take this many times its own usual time (the median of its last
 * successes) and at least SLOW_FLOOR_MS, SLOW_RUN times in a row, is taken
 * as its server asking PCP to slow down. Calls past their time limit
 * SLOW_RUN times in a row, whatever the tools, count the same.
 */
export const SLOW_FACTOR = 5
export const SLOW_FLOOR_MS = 10 * SECOND
export const SLOW_RUN = 3
/** The successes the usual time is the median of. */
export const BASELINE_SAMPLES = 20
/** Fewer successes than this: no usual time yet. */
export const BASELINE_MIN = 5
/** Tools whose usual time is kept per server; the least used is dropped. */
export const MAX_TOOLS_TRACKED = 100

/**
 * What counts as a server slowing down, per class: "latency" (a tool's
 * answers far slower than its usual, or calls past their time limit),
 * "timeouts" (only calls past their time limit: a command, a file or a
 * container takes as long as its work does), or "none" (a site's pages
 * take as long as they take; only its own "slow down" counts).
 */
export const SLOW_DETECTION: Record<
  GateClass,
  "latency" | "timeouts" | "none"
> = {
  mcp: "latency",
  endpoint: "latency",
  mail: "latency",
  calendar: "latency",
  ssh: "timeouts",
  service: "timeouts",
  storage: "timeouts",
  browser_site: "none",
  web_fetch_site: "none",
}

/**
 * A cool-down that starts within this long after the last one ended is
 * longer than that one (twice, up to the place's backoffMaxMs); later, it
 * starts again from backoffBaseMs. A place's own Retry-After (or rate
 * limit's reset) is followed up to the place's backoffMaxMs too.
 */
export const BACKOFF_MEMORY_MS = 30 * MINUTE

/**
 * After its time limit a call is answered, but its turn at the place is
 * kept until it really ends, at most this much longer: a place that is
 * slow is not sent more at once.
 */
export const LINGER_MS = MINUTE

/**
 * The counters' windows and how fine they are kept: by the minute for the
 * last hour, by the hour for the rest of the day, each with a sample of
 * its answer times for the percentiles.
 */
export const COUNTER_BUCKET_MS = MINUTE
export const COUNTER_HOUR_MS = HOUR
export const COUNTER_DAY_MS = 24 * HOUR
/** Answer times kept per minute; more are sampled evenly. */
export const SAMPLES_PER_BUCKET = 16
/** Answer times kept per hour once its minutes are merged. */
export const SAMPLES_PER_HOUR = 32

/**
 * Places whose state is held in memory, for every vault together. Past it
 * one that is idle and not cooling down is dropped, which only gives it a
 * fresh start; a place that is busy or cooling down is never dropped, so
 * the bound is passed only while more places than this are. Each place
 * holds at most 61 minute buckets of SAMPLES_PER_BUCKET times, 24 hour
 * buckets of SAMPLES_PER_HOUR and MAX_TOOLS_TRACKED tools of
 * BASELINE_SAMPLES: some 3,800 numbers, so about 30 MB at the bound.
 */
export const MAX_GATED_PLACES = 1_000
