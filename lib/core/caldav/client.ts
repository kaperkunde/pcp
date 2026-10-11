import { asBytes } from "../crypto"
import { AddressBlockedError } from "../openapi/address"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { send } from "../openapi/transport"
import { PCP_VERSION } from "../version"
import {
  acceptedAddress,
  davSendOptions,
  isElsewhere,
  PLAIN_HTTP_REFUSED,
} from "./addresses"
import {
  DAV_CALL_TIMEOUT_MS,
  MAX_CALENDARS,
  MAX_DAV_RESPONSE_BYTES,
  MAX_DISCOVERY_REDIRECTS,
  MAX_OBJECT_BYTES,
} from "./limits"
import {
  DavAuthError,
  DavRequestError,
  DavTransportError,
  type CalendarInfo,
  type DavCredential,
  type DavObject,
} from "./types"
import {
  asArray,
  calendarQueryBody,
  hrefIn,
  isNode,
  mkcalendarBody,
  parseMultistatus,
  propfindBody,
  textOf,
  type XmlNode,
} from "./xml"
import { ianaZone } from "./zones"

/**
 * A calendar account over CalDAV (RFC 4791): iCloud, Fastmail, Nextcloud,
 * Radicale, Baïkal, Google. PCP finds the calendar home from the address the
 * owner typed (the principal's calendar-home-set, RFC 6764 for a bare
 * server), lists the calendars in it, and reads and writes calendar objects
 * with WebDAV: REPORT to find them, GET, PUT and DELETE with the ETag it
 * read, so a change never overwrites one made in between.
 *
 * The credential goes only to the typed origin, or over https:// to a host
 * in its own domain (addresses.ts: acceptedAddress). Redirects are followed
 * only while finding the home, and only on the same origin; any other is
 * named for the owner to enter instead.
 */

const USER_AGENT = `pcp/${PCP_VERSION}`

type Exchange = {
  status: number
  bytes: Buffer
  etag: string | null
  location: string | null
}

function where(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return "the calendar server"
  }
}

function excerpt(bytes: Buffer): string {
  const text = bytes
    .toString("utf8")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text ? `: ${text.slice(0, 200)}` : ""
}

/** The last non-empty segment of a path, as the server spells it. */
export function lastSegment(href: string): string {
  const path = new URL(href).pathname
  return path.split("/").filter(Boolean).at(-1) ?? ""
}

export class DavClient {
  constructor(
    /** The address the owner typed: the origin the credential belongs to. */
    readonly typed: string,
    private readonly credential: DavCredential,
  ) {}

  /** One request with the credential, renewing an OAuth token once on 401. */
  async request(
    url: string,
    init: {
      method: string
      depth?: "0" | "1"
      body?: string
      contentType?: string
      headers?: Record<string, string>
      maxBytes?: number
    },
  ): Promise<Exchange> {
    const maxBytes = init.maxBytes ?? MAX_DAV_RESPONSE_BYTES

    for (let attempt = 0; ; attempt++) {
      let response: Response

      try {
        response = await send(
          url,
          {
            method: init.method,
            headers: {
              "user-agent": USER_AGENT,
              accept: "application/xml, text/calendar;q=0.9, */*;q=0.1",
              ...(init.depth !== undefined ? { depth: init.depth } : {}),
              ...(init.body !== undefined
                ? {
                    "content-type":
                      init.contentType ?? "application/xml; charset=utf-8",
                  }
                : {}),
              ...init.headers,
              ...this.credential.headers,
            },
            body:
              init.body === undefined
                ? undefined
                : asBytes(Buffer.from(init.body, "utf8")),
            signal: AbortSignal.timeout(DAV_CALL_TIMEOUT_MS),
          },
          davSendOptions(url, { elsewhere: isElsewhere(url, this.typed) }),
        )
      } catch (error) {
        if (error instanceof AddressBlockedError) {
          throw new DavTransportError(
            new URL(url).protocol === "http:"
              ? PLAIN_HTTP_REFUSED
              : error.message,
          )
        }

        throw new DavTransportError(
          `${where(url)} could not be reached: ${describeFetchError(error, DAV_CALL_TIMEOUT_MS)}`,
        )
      }

      if (response.status === 401) {
        await discard(response)
        const renewed =
          attempt === 0 && this.credential.onUnauthorized
            ? await this.credential.onUnauthorized()
            : null

        if (!renewed) {
          throw new DavAuthError(
            "The calendar server refused the credentials PCP sent.",
          )
        }

        this.credential.headers = renewed.headers
        this.credential.redact.push(...renewed.redact)
        continue
      }

      let body: { bytes: Buffer; truncated: boolean }

      try {
        body = await readCapped(response, maxBytes)
      } catch (error) {
        throw new DavTransportError(
          `${where(url)} stopped answering: ${describeFetchError(error, DAV_CALL_TIMEOUT_MS)}`,
        )
      }

      if (body.truncated) {
        throw new DavRequestError(
          `The calendar server's answer is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, more than PCP reads at once. Ask for a shorter span of time or one calendar.`,
        )
      }

      return {
        status: response.status,
        bytes: body.bytes,
        etag: response.headers.get("etag"),
        location: response.headers.get("location"),
      }
    }
  }

  /** An address the server named, if the credential may go there. */
  private accept(named: string, base: string): string {
    const url = acceptedAddress(named, base, this.typed)

    if (!url) {
      throw new DavTransportError(
        `The calendar server pointed PCP to ${where(new URL(named, base).toString())}, outside ${new URL(this.typed).host} and its domain, where PCP does not send your sign-in.`,
      )
    }

    return url
  }

  /** A PROPFIND, following same-origin redirects while discovering. */
  private async propfind(
    url: string,
    props: string[],
    depth: "0" | "1",
    { redirects = 0 }: { redirects?: number } = {},
  ): Promise<{ url: string; responses: ReturnType<typeof parseMultistatus> }> {
    let current = url

    for (let hop = 0; ; hop++) {
      const answer = await this.request(current, {
        method: "PROPFIND",
        depth,
        body: propfindBody(props),
      })

      if (answer.status >= 300 && answer.status < 400) {
        const target = answer.location
          ? new URL(answer.location, current).toString()
          : null

        if (
          target &&
          hop < redirects &&
          new URL(target).origin === new URL(current).origin
        ) {
          current = target
          continue
        }

        throw new DavTransportError(
          `${where(current)} answered with a redirect${target ? ` to ${where(target)}` : ""}. PCP does not follow it: enter that address instead.`,
        )
      }

      if (answer.status !== 207) {
        throw new DavRequestError(
          `${where(current)} answered HTTP ${answer.status}${excerpt(answer.bytes)}.`,
          { cause: answer.status },
        )
      }

      return {
        url: current,
        responses: parseMultistatus(answer.bytes.toString("utf8")),
      }
    }
  }

  /**
   * The calendar home: the typed address's calendar-home-set, or its
   * principal's. A server root that does not answer (404, 405) is asked at
   * /.well-known/caldav (RFC 6764). An address that is a home or a
   * calendar itself is taken as the home.
   */
  async discoverHome(): Promise<string> {
    const PROPS = [
      "d:current-user-principal",
      "c:calendar-home-set",
      "d:resourcetype",
    ]
    let found: Awaited<ReturnType<DavClient["propfind"]>>

    try {
      found = await this.propfind(this.typed, PROPS, "0", {
        redirects: MAX_DISCOVERY_REDIRECTS,
      })
    } catch (error) {
      const status = error instanceof DavRequestError ? error.cause : null

      if (
        (status === 404 || status === 405 || status === 403) &&
        new URL(this.typed).pathname === "/"
      ) {
        found = await this.propfind(
          new URL("/.well-known/caldav", this.typed).toString(),
          PROPS,
          "0",
          { redirects: MAX_DISCOVERY_REDIRECTS },
        )
      } else {
        throw error
      }
    }

    const props = found.responses[0]?.props ?? {}
    const home = hrefIn(props["calendar-home-set"])

    if (home) {
      return this.accept(home, found.url)
    }

    const principal = hrefIn(props["current-user-principal"])

    if (principal) {
      const principalUrl = this.accept(principal, found.url)
      const read = await this.propfind(
        principalUrl,
        ["c:calendar-home-set"],
        "0",
      )
      const named = hrefIn(read.responses[0]?.props["calendar-home-set"])

      if (named) {
        return this.accept(named, read.url)
      }
    }

    const type = props.resourcetype

    if (isNode(type) && ("calendar" in type || "collection" in type)) {
      return found.url
    }

    throw new DavTransportError(
      `${where(found.url)} did not say where your calendars are. Enter your CalDAV server's address (for iCloud, https://caldav.icloud.com).`,
    )
  }

  /** The calendars and reminder lists in the home, in the owner's order. */
  async listCalendars(home: string): Promise<CalendarInfo[]> {
    const { url, responses } = await this.propfind(
      home,
      [
        "d:resourcetype",
        "d:displayname",
        "c:supported-calendar-component-set",
        "c:calendar-description",
        "c:calendar-timezone",
        "d:current-user-privilege-set",
        "ical:calendar-color",
        "ical:calendar-order",
      ],
      "1",
    )
    const out: CalendarInfo[] = []

    for (const response of responses) {
      const type = response.props.resourcetype

      if (!isNode(type) || !("calendar" in type)) {
        continue
      }

      const href = acceptedAddress(response.href, url, this.typed)

      if (!href || href === url) {
        continue
      }

      out.push(readCalendar(href, response.props))

      if (out.length >= MAX_CALENDARS) {
        break
      }
    }

    return out.sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER),
    )
  }

  /** The objects a calendar-query REPORT finds in one calendar. */
  async query(calendar: CalendarInfo, body: string): Promise<DavObject[]> {
    const answer = await this.request(calendar.href, {
      method: "REPORT",
      depth: "1",
      body,
    })

    if (answer.status !== 207) {
      throw new DavRequestError(
        `${calendar.name} could not be searched: HTTP ${answer.status}${excerpt(answer.bytes)}.`,
        { cause: answer.status },
      )
    }

    const out: DavObject[] = []

    for (const response of parseMultistatus(answer.bytes.toString("utf8"))) {
      const href = acceptedAddress(response.href, calendar.href, this.typed)
      const data = textOf(response.props["calendar-data"])

      if (!href || !data || !href.startsWith(calendar.href)) {
        continue
      }

      out.push({ href, etag: textOf(response.props.getetag), data })
    }

    return out
  }

  async events(
    calendar: CalendarInfo,
    range: { from: number; to: number },
  ): Promise<DavObject[]> {
    return this.query(calendar, calendarQueryBody("VEVENT", range))
  }

  /**
   * A list's reminders: with `openOnly`, the server is asked for the open
   * ones, and for all of them if it does not take that filter.
   */
  async todos(
    calendar: CalendarInfo,
    { openOnly }: { openOnly: boolean },
  ): Promise<DavObject[]> {
    if (openOnly) {
      try {
        return await this.query(
          calendar,
          calendarQueryBody("VTODO", { openOnly: true }),
        )
      } catch (error) {
        if (!(error instanceof DavRequestError)) {
          throw error
        }
      }
    }

    return this.query(calendar, calendarQueryBody("VTODO", {}))
  }

  async get(href: string): Promise<DavObject> {
    const answer = await this.request(href, {
      method: "GET",
      maxBytes: MAX_OBJECT_BYTES,
    })

    if (answer.status === 404 || answer.status === 410) {
      throw new DavRequestError(
        "There is no such event or reminder (any more).",
      )
    }

    if (answer.status < 200 || answer.status >= 300) {
      throw new DavRequestError(
        `The calendar server answered HTTP ${answer.status}${excerpt(answer.bytes)}.`,
      )
    }

    return { href, etag: answer.etag, data: answer.bytes.toString("utf8") }
  }

  /**
   * Writes an object: a new one only where none is (If-None-Match), a
   * changed one only if it is still the one read (If-Match).
   */
  async put(
    href: string,
    data: string,
    condition: { create: true } | { etag: string | null },
  ): Promise<string | null> {
    const answer = await this.request(href, {
      method: "PUT",
      body: data,
      contentType: "text/calendar; charset=utf-8",
      maxBytes: 64 * 1024,
      headers:
        "create" in condition
          ? { "if-none-match": "*" }
          : condition.etag
            ? { "if-match": condition.etag }
            : {},
    })

    if (answer.status === 412) {
      throw new DavRequestError(
        "It changed on the calendar server since PCP read it, so nothing was written. Read it again and repeat the change.",
      )
    }

    if (answer.status === 403 || answer.status === 405) {
      throw new DavRequestError(
        `The calendar server would not write there (HTTP ${answer.status}): the calendar may be read-only, or not hold this kind of item${excerpt(answer.bytes)}.`,
      )
    }

    if (answer.status < 200 || answer.status >= 300) {
      throw new DavRequestError(
        `The calendar server did not take it: HTTP ${answer.status}${excerpt(answer.bytes)}.`,
      )
    }

    return answer.etag
  }

  async delete(href: string, etag: string | null): Promise<void> {
    const answer = await this.request(href, {
      method: "DELETE",
      maxBytes: 64 * 1024,
      headers: etag ? { "if-match": etag } : {},
    })

    if (answer.status === 412) {
      throw new DavRequestError(
        "It changed on the calendar server since PCP read it, so it was not deleted. Read it again first.",
      )
    }

    if (answer.status === 404 || answer.status === 410) {
      return
    }

    if (answer.status < 200 || answer.status >= 300) {
      throw new DavRequestError(
        `The calendar server did not delete it: HTTP ${answer.status}${excerpt(answer.bytes)}.`,
      )
    }
  }

  /** Makes a calendar or reminder list (MKCALENDAR, RFC 4791 5.3.1). */
  async makeCalendar(
    home: string,
    segment: string,
    input: {
      name: string
      component: "VEVENT" | "VTODO"
      color: string | null
    },
  ): Promise<string> {
    const href = new URL(
      `${encodeURIComponent(segment)}/`,
      home.endsWith("/") ? home : `${home}/`,
    ).toString()
    const answer = await this.request(href, {
      method: "MKCALENDAR",
      body: mkcalendarBody(input),
      maxBytes: 64 * 1024,
    })

    if (answer.status === 405) {
      throw new DavRequestError(
        "Something already exists at that place on the calendar server.",
      )
    }

    if (answer.status < 200 || answer.status >= 300) {
      throw new DavRequestError(
        `The calendar server did not make it: HTTP ${answer.status}${excerpt(answer.bytes)}.`,
      )
    }

    return href
  }
}

function readCalendar(href: string, props: XmlNode): CalendarInfo {
  const components = asArray(
    isNode(props["supported-calendar-component-set"])
      ? props["supported-calendar-component-set"].comp
      : undefined,
  )
    .map((comp) =>
      isNode(comp) ? String(comp["@_name"] ?? "").toUpperCase() : "",
    )
    .filter(Boolean)
  const holds: CalendarInfo["holds"] =
    components.length === 0
      ? ["events", "reminders"]
      : [
          ...(components.includes("VEVENT") ? (["events"] as const) : []),
          ...(components.includes("VTODO") ? (["reminders"] as const) : []),
        ]
  const zoneText = textOf(props["calendar-timezone"])
  const tzid = zoneText
    ? /^TZID:(.+)$/m.exec(zoneText.replace(/\r/g, ""))?.[1]?.trim()
    : null
  const privileges = props["current-user-privilege-set"]
  const granted = isNode(privileges)
    ? asArray(privileges.privilege).flatMap((privilege) =>
        isNode(privilege) ? Object.keys(privilege) : [],
      )
    : null
  const order = Number(textOf(props["calendar-order"]))
  const color = textOf(props["calendar-color"])?.trim() || null
  const name = textOf(props.displayname)?.trim()

  return {
    id: lastSegment(href),
    name: name || decodeURIComponent(lastSegment(href)),
    holds,
    color,
    description: textOf(props["calendar-description"])?.trim() || null,
    timezone: tzid ? ianaZone(tzid) : null,
    writable:
      granted === null ||
      granted.some((name) =>
        ["write", "write-content", "all", "bind"].includes(name),
      ),
    href,
    order:
      Number.isFinite(order) && textOf(props["calendar-order"]) !== null
        ? order
        : null,
  }
}
