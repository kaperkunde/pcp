import { describe, expect, it } from "vitest"

import { calendarQueryBody, mkcalendarBody, parseMultistatus } from "./xml"

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'

describe("multistatus answers", () => {
  it("reads each response's found properties, whatever the prefixes, and skips the ones not found", () => {
    const [response] = parseMultistatus(
      `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/cal/</href>` +
        `<propstat><prop><displayname>Home</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>` +
        `<propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat>` +
        `</response></multistatus>`,
    )

    expect(response).toEqual({ href: "/cal/", props: { displayname: "Home" } })
  })

  it("decodes character references once, as iCloud writes line ends", () => {
    const [response] = parseMultistatus(
      `<d:multistatus ${NS}><d:response><d:href>/a.ics</d:href><d:propstat><d:prop>` +
        `<c:calendar-data>BEGIN:VCALENDAR&#13;\nSUMMARY:Tom &amp; Jerry &amp;#13;&#13;\nEND:VCALENDAR</c:calendar-data>` +
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    )

    expect(response!.props["calendar-data"]).toBe(
      "BEGIN:VCALENDAR\r\nSUMMARY:Tom & Jerry &#13;\r\nEND:VCALENDAR",
    )
  })

  it("reads an empty answer as nothing found", () => {
    expect(parseMultistatus(`<d:multistatus ${NS}></d:multistatus>`)).toEqual(
      [],
    )
  })

  it("refuses a document type, and anything that is not a multistatus", () => {
    expect(() =>
      parseMultistatus(
        `<!DOCTYPE x [<!ENTITY a "aaaa">]><d:multistatus ${NS}/>`,
      ),
    ).toThrow(/document type/)
    expect(() => parseMultistatus("<html><body>Sign in</body></html>")).toThrow(
      /multistatus/,
    )
  })
})

describe("request bodies", () => {
  it("asks for one component, in a time range or open only", () => {
    expect(
      calendarQueryBody("VEVENT", {
        from: Date.UTC(2026, 9, 12),
        to: Date.UTC(2026, 9, 13),
      }),
    ).toContain(
      '<c:comp-filter name="VEVENT"><c:time-range start="20261012T000000Z" end="20261013T000000Z"/>',
    )
    expect(calendarQueryBody("VTODO", { openOnly: true })).toContain(
      '<c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter>',
    )
  })

  it("escapes a new calendar's name", () => {
    expect(
      mkcalendarBody({
        name: "Tom & <Jerry>",
        component: "VTODO",
        color: null,
      }),
    ).toContain("<d:displayname>Tom &amp; &lt;Jerry&gt;</d:displayname>")
  })
})
