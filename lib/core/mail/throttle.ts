import type { PcpThrottle } from "../throttle-signal"
import { scrubNotice } from "./diagnostics"

/**
 * What a mail server says when it wants PCP to slow down, as a signal the
 * call gate reads (throttle-signal.ts): IMAP's [THROTTLED], a BYE or a
 * LIMIT or UNAVAILABLE that is about rate, and JMAP's limit errors.
 * Nothing here names a vendor: it reads the protocol's own codes and the
 * plain words servers use for it.
 */

/** Words that say "too fast, too many" on their own. */
const RATE_TEXT =
  /\b(?:rate[- ]?limit\w*|throttl\w*|too many (?:simultaneous |concurrent |parallel )?(?:connections?|requests?|commands?|logins?|login attempts)|too (?:fast|frequent\w*)|slow down|bandwidth)\b/i

/**
 * Words that mean "wait" but are also what a plain outage says: they count
 * only beside a THROTTLED, LIMIT or UNAVAILABLE response code.
 */
const WAIT_TEXT = /\btry again (?:later|in)\b|\btemporar\w*/i

/** A BYE that names a limit is about rate more often than not. */
const BYE_TEXT = /\blimits?\b/i

type ImapFailure = {
  serverResponseCode?: unknown
  responseCode?: unknown
  responseText?: unknown
  responseStatus?: unknown
  reason?: unknown
  code?: unknown
  throttleReset?: unknown
  message?: unknown
  authenticationFailed?: unknown
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : ""

export function imapThrottle(
  error: unknown,
  /** The login PCP signed in with, kept out of what is said. */
  secrets: string[] = [],
): PcpThrottle | null {
  if (!error || typeof error !== "object") {
    return null
  }

  const failure = error as ImapFailure
  const code = text(failure.serverResponseCode ?? failure.responseCode)
    .toUpperCase()
    .replace(/[^A-Z-]/g, "")
  const said = text(failure.responseText) || text(failure.reason)
  const backoff = /Backoff Time[:=\s]+(\d+)/i.exec(said)
  const retryAfterMs =
    typeof failure.throttleReset === "number"
      ? failure.throttleReset
      : backoff
        ? Number(backoff[1])
        : undefined
  const signal = (): PcpThrottle => ({
    reason: `The IMAP server is throttling PCP${said ? `: ${scrubNotice(said, secrets)}` : "."}`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })

  if (code === "THROTTLED" || failure.code === "ETHROTTLE") {
    return signal()
  }

  // BYE: the server ended the session and said why.
  if (text(failure.reason) && (RATE_TEXT.test(said) || BYE_TEXT.test(said))) {
    return signal()
  }

  // LIMIT and UNAVAILABLE (and any refusal) where the words are about rate:
  // a message that is too large or a server that is down is not.
  const coded = code === "LIMIT" || code === "UNAVAILABLE"

  if (
    said &&
    !failure.authenticationFailed &&
    (RATE_TEXT.test(said) || (coded && WAIT_TEXT.test(said)))
  ) {
    return signal()
  }

  return null
}

/**
 * A call that went through, but whose answers the server marked
 * [THROTTLED]: it is slowing PCP down on purpose (Gmail does this to an
 * account, taking seconds over each answer), so the call gate cools the
 * server down rather than let every call wait out its time limit.
 */
export function noticeThrottle(notices: string[]): PcpThrottle | null {
  return notices.some((notice) => /\[THROTTLED\]/i.test(notice))
    ? {
        reason:
          "The IMAP server marks its answers [THROTTLED]: it is slowing PCP down",
      }
    : null
}

/**
 * JMAP's request-level limit (urn:ietf:params:jmap:error:limit, RFC 8620
 * 3.6.1): about rate only when the limit is concurrent requests. A limit
 * on a request's size or calls is a problem with the request.
 */
export function jmapLimitThrottle(problem: {
  type?: unknown
  limit?: unknown
  detail?: unknown
}): PcpThrottle | null {
  if (
    problem.type !== "urn:ietf:params:jmap:error:limit" ||
    text(problem.limit) !== "maxConcurrentRequests"
  ) {
    return null
  }

  const detail = text(problem.detail)

  return {
    reason: `The JMAP server limits the requests PCP may make at once${detail ? `: ${scrubNotice(detail)}` : "."}`,
  }
}

/** A JMAP method that answered with an error about rate. */
export function jmapMethodThrottle(type: unknown): PcpThrottle | null {
  return /rate[-_ ]?limit|too[-_ ]?many|throttl/i.test(text(type))
    ? {
        reason: `The JMAP server is throttling PCP (${text(type).slice(0, 60)}).`,
      }
    : null
}
