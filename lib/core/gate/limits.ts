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
 * Throttle detection by latency: a place whose answers take this many
 * times its own usual time (the median of its last successes) and at least
 * SLOW_FLOOR_MS, SLOW_RUN times in a row, is treated as asking PCP to slow
 * down. A call that runs past its time limit counts as slow whatever the
 * usual is.
 */
export const SLOW_FACTOR = 5
export const SLOW_FLOOR_MS = 10 * SECOND
export const SLOW_RUN = 3
/** The successes the usual time is the median of. */
export const BASELINE_SAMPLES = 20
/** Fewer successes than this: no usual time yet. */
export const BASELINE_MIN = 5

/**
 * A cool-down that starts within this long after the last one ended is
 * longer than that one (twice, up to the place's backoffMaxMs); later, it
 * starts again from backoffBaseMs.
 */
export const BACKOFF_MEMORY_MS = 30 * MINUTE

/** The longest a place's own Retry-After is followed. */
export const MAX_RETRY_AFTER_MS = 24 * HOUR

/**
 * After its time limit a call is answered, but its turn at the place is
 * kept until it really ends, at most this much longer: a place that is
 * slow is not sent more at once.
 */
export const LINGER_MS = MINUTE

/** The counters' windows, and how fine they are kept. */
export const COUNTER_BUCKET_MS = MINUTE
export const COUNTER_DAY_MS = 24 * HOUR
/** Latencies kept per minute for the percentiles; more are sampled. */
export const SAMPLES_PER_BUCKET = 32

/**
 * Places whose state is held in memory, for every vault together. Past it
 * one that is idle is dropped, which only gives it a fresh start.
 */
export const MAX_GATED_PLACES = 10_000
