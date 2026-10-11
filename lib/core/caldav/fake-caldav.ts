/**
 * An in-memory CalDAV server for tests: the unit tests mount it on
 * startTestApi, the e2e suite on its fake upstream. It is shaped like
 * iCloud: the root answers with the principal, the principal names the
 * calendar home, and the home holds calendars and reminder lists. It answers
 * the requests PCP makes (PROPFIND, REPORT calendar-query, GET, PUT and
 * DELETE with ETags, MKCALENDAR) well enough to check what PCP sends and
 * what it makes of the answers, and records each request with its
 * Authorization header. A calendar-query returns every object of the
 * component it names (PCP filters by time itself), and the open-only filter
 * is refused unless `openFilter` is on, as some servers do.
 */

export type FakeCalendar = {
  id: string
  name: string
  components: Array<"VEVENT" | "VTODO">
  color?: string
  timezone?: string
  readOnly?: boolean
  order?: number
  /** Object name (e.g. "abc.ics") → its iCalendar text. */
  objects: Map<string, { data: string; etag: string }>
}

export type FakeCalDavRequest = {
  method: string
  path: string
  authorization: string | undefined
  depth: string | undefined
  ifMatch: string | undefined
  ifNoneMatch: string | undefined
  body: string
}

export type FakeCalDavOptions = {
  /** Where the server lives, e.g. "/caldav". */
  base?: string
  /** Whether a request with this Authorization header may in. */
  authorize: (authorization: string | undefined) => boolean
  /** The home's address as the principal names it (to test the origin rule). */
  homeHref?: string
  /** Whether a calendar-query with the open-only filter is answered. */
  openFilter?: boolean
}

export type FakeAnswer = {
  status: number
  type?: string
  body?: string
  headers?: Record<string, string>
}

export type FakeCalDav = {
  calendars: Map<string, FakeCalendar>
  requests: FakeCalDavRequest[]
  homePath: string
  principalPath: string
  addCalendar: (calendar: Omit<FakeCalendar, "objects">) => FakeCalendar
  put: (calendarId: string, name: string, data: string) => string
  handle: (request: {
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
    body: string
  }) => FakeAnswer | null
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

const NS =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/"'

function multistatus(responses: string[]): FakeAnswer {
  return {
    status: 207,
    type: "application/xml; charset=utf-8",
    body: `<?xml version="1.0" encoding="UTF-8"?><d:multistatus ${NS}>${responses.join("")}</d:multistatus>`,
  }
}

function response(href: string, props: string): string {
  return `<d:response><d:href>${escape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function createFakeCalDav(options: FakeCalDavOptions): FakeCalDav {
  const base = options.base ?? ""
  const principalPath = `${base}/123456/principal/`
  const homePath = `${base}/123456/calendars/`
  const calendars = new Map<string, FakeCalendar>()
  const requests: FakeCalDavRequest[] = []
  let tag = 0

  const addCalendar: FakeCalDav["addCalendar"] = (calendar) => {
    const made = { ...calendar, objects: new Map() }
    calendars.set(calendar.id, made)
    return made
  }

  const put: FakeCalDav["put"] = (calendarId, name, data) => {
    const etag = `"e${++tag}"`
    calendars.get(calendarId)!.objects.set(name, { data, etag })
    return etag
  }

  function calendarProps(calendar: FakeCalendar): string {
    return [
      "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
      `<d:displayname>${escape(calendar.name)}</d:displayname>`,
      `<c:supported-calendar-component-set>${calendar.components.map((name) => `<c:comp name="${name}"/>`).join("")}</c:supported-calendar-component-set>`,
      calendar.color
        ? `<ical:calendar-color>${calendar.color}</ical:calendar-color>`
        : "",
      calendar.order !== undefined
        ? `<ical:calendar-order>${calendar.order}</ical:calendar-order>`
        : "",
      calendar.timezone
        ? `<c:calendar-timezone>BEGIN:VCALENDAR&#13;\nBEGIN:VTIMEZONE&#13;\nTZID:${calendar.timezone}&#13;\nEND:VTIMEZONE&#13;\nEND:VCALENDAR</c:calendar-timezone>`
        : "",
      `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${calendar.readOnly ? "" : "<d:privilege><d:write/></d:privilege>"}</d:current-user-privilege-set>`,
    ].join("")
  }

  return {
    calendars,
    requests,
    homePath,
    principalPath,
    addCalendar,
    put,
    handle(request) {
      const url = new URL(request.url, "http://fake")
      const path = decodeURIComponent(url.pathname)

      if (!path.startsWith(`${base}/`) && path !== base) {
        return null
      }

      const authorization = header(request.headers, "authorization")
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization,
        depth: header(request.headers, "depth"),
        ifMatch: header(request.headers, "if-match"),
        ifNoneMatch: header(request.headers, "if-none-match"),
        body: request.body,
      })

      if (!options.authorize(authorization)) {
        return {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="fake"' },
          body: "",
        }
      }

      const root = path === `${base}/` || path === base
      const wellKnown = path === `${base}/.well-known/caldav`

      if (request.method === "PROPFIND" && wellKnown) {
        return { status: 301, headers: { location: `${base}/` }, body: "" }
      }

      if (request.method === "PROPFIND" && root) {
        return multistatus([
          response(
            url.pathname,
            `<d:current-user-principal><d:href>${principalPath}</d:href></d:current-user-principal>`,
          ),
        ])
      }

      if (request.method === "PROPFIND" && path === principalPath) {
        return multistatus([
          response(
            principalPath,
            `<c:calendar-home-set><d:href>${escape(options.homeHref ?? homePath)}</d:href></c:calendar-home-set>`,
          ),
        ])
      }

      if (request.method === "PROPFIND" && path === homePath) {
        return multistatus([
          response(
            homePath,
            "<d:resourcetype><d:collection/></d:resourcetype>",
          ),
          // iCloud's inbox: a collection that is not a calendar.
          response(
            `${homePath}inbox/`,
            "<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>",
          ),
          ...[...calendars.values()].map((calendar) =>
            response(`${homePath}${calendar.id}/`, calendarProps(calendar)),
          ),
        ])
      }

      const match = new RegExp(`^${homePath}([^/]+)/(?:([^/]+))?$`).exec(path)
      const calendar = match ? calendars.get(match[1]!) : undefined
      const name = match?.[2]

      if (request.method === "MKCALENDAR" && match && !name) {
        if (calendar) {
          return { status: 405, body: "" }
        }

        const display =
          /<d:displayname>([^<]*)<\/d:displayname>/.exec(request.body)?.[1] ??
          match[1]!
        const component = /name="(VEVENT|VTODO)"/.exec(request.body)?.[1] as
          "VEVENT" | "VTODO" | undefined
        addCalendar({
          id: match[1]!,
          name: display,
          components: [component ?? "VEVENT"],
        })
        return { status: 201, body: "" }
      }

      if (!calendar) {
        return { status: 404, body: "" }
      }

      if (request.method === "REPORT" && !name) {
        const component = /comp-filter name="(VEVENT|VTODO)"/.exec(
          request.body,
        )?.[1]

        if (/is-not-defined/.test(request.body) && !options.openFilter) {
          return { status: 400, body: "unsupported filter" }
        }

        return multistatus(
          [...calendar.objects.entries()]
            .filter(
              ([, object]) =>
                !component || object.data.includes(`BEGIN:${component}`),
            )
            .map(([objectName, object]) =>
              response(
                `${homePath}${calendar.id}/${objectName}`,
                `<d:getetag>${escape(object.etag)}</d:getetag><c:calendar-data>${escape(object.data)}</c:calendar-data>`,
              ),
            ),
        )
      }

      if (!name) {
        return { status: 405, body: "" }
      }

      const existing = calendar.objects.get(name)
      const ifMatch = header(request.headers, "if-match")
      const ifNoneMatch = header(request.headers, "if-none-match")

      switch (request.method) {
        case "GET":
          return existing
            ? {
                status: 200,
                type: "text/calendar; charset=utf-8",
                body: existing.data,
                headers: { etag: existing.etag },
              }
            : { status: 404, body: "" }

        case "PUT": {
          if (calendar.readOnly) {
            return { status: 403, body: "read-only" }
          }

          if (
            (ifNoneMatch === "*" && existing) ||
            (ifMatch && existing?.etag !== ifMatch)
          ) {
            return { status: 412, body: "" }
          }

          const etag = put(calendar.id, name, request.body)
          return { status: existing ? 204 : 201, headers: { etag }, body: "" }
        }

        case "DELETE":
          if (!existing) {
            return { status: 404, body: "" }
          }

          if (ifMatch && existing.etag !== ifMatch) {
            return { status: 412, body: "" }
          }

          calendar.objects.delete(name)
          return { status: 204, body: "" }
      }

      return { status: 405, body: "" }
    },
  }
}
