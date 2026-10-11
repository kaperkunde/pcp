/**
 * What a calendar account looks like to the rest of PCP: the credential
 * upstream.ts hands in, and the errors the CalDAV client throws. Nothing
 * here reads a secret.
 */

export type DavCredential = {
  /** Sent with each request (Authorization). */
  headers: Record<string, string>
  /** Values that would give the credential away if an answer repeated them. */
  redact: string[]
  /**
   * OAuth: renew the token after the server refused it, and hand back the
   * new header; null when the owner has to connect again.
   */
  onUnauthorized?: () => Promise<{
    headers: Record<string, string>
    redact: string[]
  } | null>
}

/** A calendar collection: events, reminders (to-dos), or both. */
export type CalendarInfo = {
  /** Its last path segment, as the server spells it: what tools take. */
  id: string
  name: string
  /** What it holds: "events" (VEVENT) and "reminders" (VTODO). */
  holds: Array<"events" | "reminders">
  color: string | null
  description: string | null
  /** The zone it names for times without one, when it names one. */
  timezone: string | null
  /** Whether this sign-in may write to it (a subscription is read-only). */
  writable: boolean
  /** Where it is: absolute, on the home's origin. */
  href: string
  /** Its place in the owner's list (Apple's calendar-order). */
  order: number | null
}

/** A calendar object as the server holds it. */
export type DavObject = {
  href: string
  etag: string | null
  data: string
}

/** The server refused the credentials (after a renewal, for OAuth). */
export class DavAuthError extends Error {
  override name = "DavAuthError"
}

/** The server could not be reached, or did not speak CalDAV. */
export class DavTransportError extends Error {
  override name = "DavTransportError"
}

/**
 * The account is fine, but this request could not be done: no such event
 * or calendar, an event changed in between, the server said no. The
 * assistant is told; the account's status stays as it is.
 */
export class DavRequestError extends Error {
  override name = "DavRequestError"
}
