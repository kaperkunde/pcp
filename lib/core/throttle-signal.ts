/**
 * A place's own "slow down" (#143), carried beside an Error or an answer so
 * the call gate (lib/core/gate/) can cool it down (a refusal) or make its
 * calls go slower (`slow`: an answer it marked throttled) without knowing
 * the protocol: IMAP's [THROTTLED] and BYE texts and JMAP's limit errors
 * (mail/throttle.ts), HTTP 429, and 503 with Retry-After (httpThrottle,
 * read by mail, CalDAV, API endpoints, MCP servers and web fetch). The
 * error keeps its own message for the assistant; the signal rides beside it
 * as `pcpThrottle`, which the gate reads anywhere on the `cause` chain and
 * takes off an answer before it is passed on.
 *
 * A rate limit with nothing left (`RateLimit-Remaining: 0`, or its X-
 * form) on an answer that is not itself a refusal is a `hold`: the next
 * call waits for the reset, and nothing cools down (rateLimitHold).
 */

export type PcpThrottle = {
  /** Plain words: what the server said, short and free of addresses. */
  reason: string
  /** How long the server asked PCP to wait, when it said. */
  retryAfterMs?: number
  /**
   * Only wait this long before the next call (a rate limit with nothing
   * left): no cool-down, no slow-down counted.
   */
  hold?: boolean
  /**
   * Go slower, not stop: the place answered, but marked it throttled. Its
   * calls still go, one at a time and further apart (lib/core/gate/); only
   * a refusal (no `slow`) cools it down.
   */
  slow?: boolean
}

/** The same, by the name the gate uses. */
export type Throttle = PcpThrottle

/** The longest wait a server's hint can ask for. */
export const MAX_THROTTLE_RETRY_MS = 60 * 60 * 1000

const MAX_REASON = 200

function asThrottle(value: unknown): PcpThrottle | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const { reason, retryAfterMs, hold, slow } = value as Record<string, unknown>

  if (typeof reason !== "string" || reason.trim() === "") {
    return null
  }

  return {
    reason: reason.trim().replace(/\s+/g, " ").slice(0, MAX_REASON),
    ...(typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
      ? {
          retryAfterMs: Math.min(
            Math.round(retryAfterMs),
            MAX_THROTTLE_RETRY_MS,
          ),
        }
      : {}),
    ...(hold === true ? { hold: true } : {}),
    ...(slow === true ? { slow: true } : {}),
  }
}

/**
 * An error or an answer marked as a place's request to slow down. Kept off
 * the value's own keys, so an answer that carries one is never sent on with
 * it.
 */
export function withThrottle<T extends object>(
  value: T,
  throttle: PcpThrottle | null,
): T {
  const checked = asThrottle(throttle)

  if (checked) {
    Object.defineProperty(value, "pcpThrottle", {
      value: checked,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }

  return value
}

/** The throttle an error (or one of its causes) or an answer carries. */
export function throttleOf(value: unknown): PcpThrottle | null {
  for (
    let at: unknown = value, depth = 0;
    at && typeof at === "object" && depth < 5;
    depth++
  ) {
    const found = asThrottle((at as { pcpThrottle?: unknown }).pcpThrottle)

    if (found) {
      return found
    }

    at = (at as { cause?: unknown }).cause
  }

  return null
}

/** Takes a throttle off an answer before it is passed on. */
export function stripThrottle<T extends object>(value: T): T {
  if (Object.prototype.hasOwnProperty.call(value, "pcpThrottle")) {
    delete (value as { pcpThrottle?: unknown }).pcpThrottle
  }

  return value
}

/** A Retry-After header: seconds, or an HTTP date. Milliseconds, or undefined. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const text = value?.trim()

  if (!text) {
    return undefined
  }

  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.min(Math.round(Number(text) * 1000), MAX_THROTTLE_RETRY_MS)
  }

  const at = Date.parse(text)

  return Number.isNaN(at)
    ? undefined
    : Math.min(Math.max(0, at - now), MAX_THROTTLE_RETRY_MS)
}

/**
 * A rate-limit header's reset: seconds from now (RateLimit-Reset, and most
 * X-RateLimit-Reset), or a Unix time in seconds (some APIs'
 * X-RateLimit-Reset), told apart by size.
 */
function resetMsOf(raw: string | null, now: number): number | undefined {
  if (raw === null || !/^\s*\d+(\.\d+)?\s*$/.test(raw)) {
    return undefined
  }

  const value = Number(raw)
  const ms =
    value > 1_000_000_000
      ? Math.max(0, Math.round(value * 1000 - now))
      : Math.round(value * 1000)

  return Math.min(ms, MAX_THROTTLE_RETRY_MS)
}

type HeaderSource = Pick<Headers, "get">

/**
 * A header source over the plain object a browser library hands back
 * (Playwright's response.headers(): lower-case names, a header sent more
 * than once joined with a newline). The WHATWG Headers constructor refuses
 * such a value, and a page that sends several Content-Security-Policy
 * headers (Google's) made the call that read them fail, so this one only
 * looks a name up and never throws. A header sent more than once reads as WHATWG Headers joins it, with ", ".
 */
export function plainHeaders(headers: Record<string, string>): HeaderSource {
  const lower = new Map<string, string>()

  for (const [name, value] of Object.entries(headers)) {
    lower.set(name.toLowerCase(), value.split("\n").join(", "))
  }

  return { get: (name) => lower.get(name.toLowerCase()) ?? null }
}

/**
 * HTTP's own: 429 always, and 503 when the server says when to come back
 * (a 503 with no Retry-After is a server that is down, not one asking for
 * time); how long, from Retry-After, else the rate limit's reset. Null for
 * any other answer. `who` names the server in the reason.
 */
export function httpThrottle(
  status: number,
  headers: HeaderSource,
  who: string = "It",
  now: number = Date.now(),
): PcpThrottle | null {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), now)

  if (status !== 429 && !(status === 503 && retryAfterMs !== undefined)) {
    return null
  }

  const wait =
    retryAfterMs ??
    resetMsOf(headers.get("ratelimit-reset"), now) ??
    resetMsOf(headers.get("x-ratelimit-reset"), now)

  return {
    reason: `${who} answered HTTP ${status}: it asks PCP to slow down`,
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
  }
}

/**
 * An answer that went through but says its rate limit has nothing left
 * until a reset: a hold until then, for the gate to make the next call
 * wait (never a cool-down: the limit may be one bucket of many). Null
 * otherwise, and for a refusal, which httpThrottle reads.
 */
export function rateLimitHold(
  status: number,
  headers: HeaderSource,
  now: number = Date.now(),
): PcpThrottle | null {
  if (status === 429 || status === 503) {
    return null
  }

  const remaining =
    headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining")

  if (remaining === null || !/^\s*0+\s*$/.test(remaining)) {
    return null
  }

  const reset =
    resetMsOf(headers.get("ratelimit-reset"), now) ??
    resetMsOf(headers.get("x-ratelimit-reset"), now)

  return reset === undefined || reset <= 0
    ? null
    : {
        reason: "its rate limit has no calls left until it resets",
        retryAfterMs: reset,
        hold: true,
      }
}

/** A throttle the HTTP answer carries: a refusal first, else a hold. */
export function httpSignal(
  status: number,
  headers: HeaderSource,
  who?: string,
  now: number = Date.now(),
): PcpThrottle | null {
  return (
    httpThrottle(status, headers, who, now) ??
    rateLimitHold(status, headers, now)
  )
}
