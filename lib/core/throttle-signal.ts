/**
 * A protocol's own "slow down", carried on an Error so the call gate
 * (lib/core/gate/) can cool an upstream down without knowing the protocol:
 * IMAP's [THROTTLED] and BYE texts, JMAP's limit errors, HTTP 429 and 503
 * with Retry-After. The error keeps its own message for the assistant; the
 * signal rides beside it as `pcpThrottle`.
 */

export type PcpThrottle = {
  /** Plain words: what the server said, short and free of addresses. */
  reason: string
  /** How long the server asked PCP to wait, when it said. */
  retryAfterMs?: number
}

/** The longest wait a server's hint can ask for. */
export const MAX_THROTTLE_RETRY_MS = 60 * 60 * 1000

export function withThrottle<E extends Error>(
  error: E,
  throttle: PcpThrottle,
): E {
  const retryAfterMs =
    throttle.retryAfterMs === undefined
      ? undefined
      : Math.min(
          Math.max(0, Math.round(throttle.retryAfterMs)),
          MAX_THROTTLE_RETRY_MS,
        )

  ;(error as E & { pcpThrottle?: PcpThrottle }).pcpThrottle = {
    reason: throttle.reason.slice(0, 200),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }

  return error
}

export function throttleOf(error: unknown): PcpThrottle | null {
  const found = (error as { pcpThrottle?: unknown } | null)?.pcpThrottle

  if (
    found &&
    typeof found === "object" &&
    typeof (found as PcpThrottle).reason === "string"
  ) {
    return found as PcpThrottle
  }

  return null
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

  if (/^\d+$/.test(text)) {
    return Math.min(Number(text) * 1000, MAX_THROTTLE_RETRY_MS)
  }

  const at = Date.parse(text)

  return Number.isNaN(at)
    ? undefined
    : Math.min(Math.max(0, at - now), MAX_THROTTLE_RETRY_MS)
}

/**
 * HTTP's own: 429 always, and 503 when the server says when to come back
 * (a 503 with no Retry-After is a server that is down, not one asking for
 * time). Null for any other answer.
 */
export function httpThrottle(
  status: number,
  headers: Pick<Headers, "get">,
  who: string,
): PcpThrottle | null {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"))

  if (status === 429 || (status === 503 && retryAfterMs !== undefined)) {
    return {
      reason: `${who} answered HTTP ${status}: it asks PCP to slow down.`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
  }

  return null
}
