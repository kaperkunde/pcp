import { MAX_RETRY_AFTER_MS } from "./limits"

/**
 * A place asking PCP to slow down (lib/core/gate/): why, in a few words the
 * owner and an assistant read, and how long it asked for, when it said.
 *
 * The contract between the code that talks to a place and the gate: an
 * Error (anywhere on its `cause` chain) or an answer that carries
 * `pcpThrottle: { reason, retryAfterMs? }`. Mail and calendar code raise it
 * from their protocols' own signals; an API endpoint's and an MCP server's
 * HTTP answers are read here (httpThrottle). The gate takes it off an
 * answer before it is handed on.
 */
export type Throttle = { reason: string; retryAfterMs?: number }

const MAX_REASON = 200

function asThrottle(value: unknown): Throttle | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const { reason, retryAfterMs } = value as Record<string, unknown>

  if (typeof reason !== "string" || reason.trim() === "") {
    return null
  }

  return {
    reason: reason.trim().replace(/\s+/g, " ").slice(0, MAX_REASON),
    ...(typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
      ? { retryAfterMs: Math.min(Math.round(retryAfterMs), MAX_RETRY_AFTER_MS) }
      : {}),
  }
}

/** The throttle an error or an answer carries, or null. */
export function throttleOf(value: unknown): Throttle | null {
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

/** An answer or error marked as a place's request to slow down. */
export function withThrottle<T extends object>(
  value: T,
  throttle: Throttle | null,
): T {
  if (throttle) {
    Object.defineProperty(value, "pcpThrottle", {
      value: throttle,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }

  return value
}

/** Takes a throttle off an answer before it is passed on. */
export function stripThrottle<T extends object>(value: T): T {
  if (Object.prototype.hasOwnProperty.call(value, "pcpThrottle")) {
    delete (value as { pcpThrottle?: unknown }).pcpThrottle
  }

  return value
}

/** A header's value as milliseconds from now, or null. */
function retryAfterMsOf(raw: string | null, now: number): number | null {
  if (raw === null || raw.trim() === "") {
    return null
  }

  const value = raw.trim()

  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000)
  }

  const at = Date.parse(value)

  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/**
 * A rate-limit header's reset: seconds from now (RateLimit-Reset, and most
 * X-RateLimit-Reset), or a Unix time in seconds (GitHub's and others'
 * X-RateLimit-Reset), told apart by size.
 */
function resetMsOf(raw: string | null, now: number): number | null {
  if (raw === null || !/^\s*\d+(\.\d+)?\s*$/.test(raw)) {
    return null
  }

  const value = Number(raw)

  return value > 1_000_000_000
    ? Math.max(0, Math.round(value * 1000 - now))
    : Math.round(value * 1000)
}

type HeaderSource = { get(name: string): string | null }

/**
 * What an HTTP answer says about slowing down: 429 Too Many Requests, or
 * 503 with a Retry-After, is a request to; so is a success whose
 * rate-limit headers (RateLimit-*, X-RateLimit-*) say nothing is left
 * until a reset. Retry-After first, then the reset.
 */
export function httpThrottle(
  status: number,
  headers: HeaderSource,
  now = Date.now(),
): Throttle | null {
  const retryAfter = retryAfterMsOf(headers.get("retry-after"), now)
  const reset =
    resetMsOf(headers.get("ratelimit-reset"), now) ??
    resetMsOf(headers.get("x-ratelimit-reset"), now)
  const wait = retryAfter ?? reset
  const withWait = (reason: string): Throttle =>
    asThrottle({ reason, retryAfterMs: wait ?? undefined })!

  if (status === 429) {
    return withWait("it answered HTTP 429 (too many requests)")
  }

  if (status === 503 && retryAfter !== null) {
    return withWait("it answered HTTP 503 and asked to be called again later")
  }

  const remaining =
    headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining")

  if (
    remaining !== null &&
    /^\s*0+\s*$/.test(remaining) &&
    reset !== null &&
    reset > 0
  ) {
    return withWait("its rate limit has no calls left until it resets")
  }

  return null
}
