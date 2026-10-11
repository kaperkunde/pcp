import { XMLParser } from "fast-xml-parser"

import { DavTransportError } from "./types"

/**
 * WebDAV's XML, as far as PCP speaks it: the request bodies it writes
 * (PROPFIND, REPORT, MKCALENDAR) and the multistatus answers it reads. An
 * answer is the server's, so it is untrusted: a document type (and with it
 * any entity) is refused before parsing, and namespaces are dropped, since
 * the properties PCP asks for have names no two namespaces share.
 */

export const NAMESPACES =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"'

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function propfindBody(props: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NAMESPACES}><d:prop>${props.map((prop) => `<${prop}/>`).join("")}</d:prop></d:propfind>`
}

/** A UTC time as CalDAV's time-range takes it: 20261012T090000Z. */
export function davUtc(instant: number): string {
  return new Date(instant)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
}

/**
 * A calendar-query REPORT (RFC 4791 7.8) for one component: VEVENT within
 * a time range, or VTODO, the open ones only with `openOnly` (no COMPLETED).
 */
export function calendarQueryBody(
  component: "VEVENT" | "VTODO",
  {
    from,
    to,
    openOnly = false,
  }: { from?: number; to?: number; openOnly?: boolean },
): string {
  const range =
    from !== undefined && to !== undefined
      ? `<c:time-range start="${davUtc(from)}" end="${davUtc(to)}"/>`
      : ""
  const open = openOnly
    ? '<c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter>'
    : ""

  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NAMESPACES}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${component}">${range}${open}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
}

export function mkcalendarBody({
  name,
  component,
  color,
}: {
  name: string
  component: "VEVENT" | "VTODO"
  color: string | null
}): string {
  return `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar ${NAMESPACES}><d:set><d:prop><d:displayname>${escapeXml(name)}</d:displayname><c:supported-calendar-component-set><c:comp name="${component}"/></c:supported-calendar-component-set>${color ? `<ical:calendar-color>${escapeXml(color)}</ical:calendar-color>` : ""}</d:prop></d:set></c:mkcalendar>`
}

export type XmlNode = Record<string, unknown>

export type DavResponse = {
  href: string
  /** The properties the server found (status 2xx), by local name. */
  props: XmlNode
}

const ARRAYS = new Set(["response", "propstat", "href", "comp", "privilege"])

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  // Character references too: iCloud writes a calendar's line ends as &#13;.
  htmlEntities: true,
  isArray: (name) => ARRAYS.has(name),
})

export function parseXml(text: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new DavTransportError(
      "The CalDAV server answered with a document type, which PCP does not read.",
    )
  }

  try {
    const parsed = parser.parse(text) as unknown

    if (parsed && typeof parsed === "object") {
      return parsed as XmlNode
    }
  } catch {
    // Said below.
  }

  throw new DavTransportError(
    "The CalDAV server's answer is not XML; is this a CalDAV address?",
  )
}

export function isNode(value: unknown): value is XmlNode {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** An element's text: its own, or "#text" beside its attributes. */
export function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (isNode(value) && typeof value["#text"] === "string") {
    return value["#text"]
  }

  if (Array.isArray(value)) {
    return textOf(value[0])
  }

  return null
}

/** The text of the first href inside an element (current-user-principal). */
export function hrefIn(value: unknown): string | null {
  if (!isNode(value)) {
    return null
  }

  const href = value.href

  return textOf(Array.isArray(href) ? href[0] : href)?.trim() || null
}

export function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** A multistatus answer's responses, each with the properties found. */
export function parseMultistatus(text: string): DavResponse[] {
  const root = parseXml(text)
  const multistatus = root.multistatus

  // An empty one (nothing found) parses as its empty text.
  if (multistatus === "") {
    return []
  }

  if (!isNode(multistatus)) {
    throw new DavTransportError(
      "The CalDAV server's answer is not a WebDAV multistatus; is this a CalDAV address?",
    )
  }

  const out: DavResponse[] = []

  for (const response of asArray(multistatus.response)) {
    if (!isNode(response)) {
      continue
    }

    const href = textOf(asArray(response.href)[0])?.trim()

    if (!href) {
      continue
    }

    const props: XmlNode = {}

    for (const propstat of asArray(response.propstat)) {
      if (!isNode(propstat)) {
        continue
      }

      const status = textOf(propstat.status) ?? ""

      if (!/\s2\d\d\s/.test(` ${status} `) || !isNode(propstat.prop)) {
        continue
      }

      Object.assign(props, propstat.prop)
    }

    out.push({ href, props })
  }

  return out
}
