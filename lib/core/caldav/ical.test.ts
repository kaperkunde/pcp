import ICAL from "ical.js"
import { describe, expect, it } from "vitest"

import {
  changeEvent,
  changeReminder,
  completeReminder,
  newEventObject,
  newReminderObject,
  parseCalendarObject,
  parseTimeInput,
  removeOccurrence,
} from "./compose"
import {
  describeRule,
  expandEvents,
  formatTime,
  occurrenceOf,
  parseOccurrenceKey,
  readReminder,
} from "./ical"
import { intlZone } from "./zones"

const ZONE = "Europe/Amsterdam"
const AMS = intlZone(ZONE)
const range = (from: string, to: string) => ({
  from: Date.parse(from),
  to: Date.parse(to),
})

function ics(...lines: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:test",
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n")
}

function starts(data: string, from: string, to: string): string[] {
  return expandEvents(
    parseCalendarObject(data),
    range(from, to),
    AMS,
  ).occurrences.map((o) => formatTime(o.start, AMS))
}

const WEEKLY = ics(
  "BEGIN:VEVENT",
  "UID:standup",
  "DTSTAMP:20260101T000000Z",
  "DTSTART;TZID=Europe/Amsterdam:20261020T090000",
  "DTEND;TZID=Europe/Amsterdam:20261020T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261105T080000Z",
  "EXDATE;TZID=Europe/Amsterdam:20261022T090000",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup",
  "DTSTAMP:20260101T000000Z",
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20261029T090000",
  "DTSTART;TZID=Europe/Amsterdam:20261029T140000",
  "DTEND;TZID=Europe/Amsterdam:20261029T143000",
  "SUMMARY:Standup (afternoon)",
  "END:VEVENT",
)

describe("reading events", () => {
  it("steps a weekly series in its wall clock, across the change from summer time", () => {
    expect(
      starts(WEEKLY, "2026-10-19T00:00:00Z", "2026-11-30T00:00:00Z"),
    ).toEqual([
      "2026-10-20T09:00:00+02:00",
      // 22 October is excluded.
      "2026-10-27T09:00:00+01:00",
      // The exception moved this one to the afternoon.
      "2026-10-29T14:00:00+01:00",
      "2026-11-03T09:00:00+01:00",
      // UNTIL is 08:00 UTC on the 5th: 09:00 in Amsterdam, which it includes.
      "2026-11-05T09:00:00+01:00",
    ])
  })

  it("gives each occurrence its key, and finds it again by that key", () => {
    const calendar = parseCalendarObject(WEEKLY)
    const { occurrences } = expandEvents(
      calendar,
      range("2026-10-28T00:00:00Z", "2026-10-30T00:00:00Z"),
      AMS,
    )

    expect(occurrences.map((o) => o.occurrence)).toEqual([
      "2026-10-29T08:00:00Z",
    ])
    expect(parseOccurrenceKey("2026-10-29T09:00:00+01:00")).toBe(
      "2026-10-29T08:00:00Z",
    )
    const found = occurrenceOf(calendar, "2026-10-29T08:00:00Z", AMS)!
    expect(found.event.getFirstPropertyValue("summary")).toBe(
      "Standup (afternoon)",
    )
  })

  it("keeps all-day events as dates, ending on their last day", () => {
    const data = ics(
      "BEGIN:VEVENT",
      "UID:trip",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;VALUE=DATE:20261012",
      "DTEND;VALUE=DATE:20261015",
      "SUMMARY:Trip",
      "END:VEVENT",
    )
    const [trip] = expandEvents(
      parseCalendarObject(data),
      range("2026-10-14T00:00:00Z", "2026-10-20T00:00:00Z"),
      AMS,
    ).occurrences

    expect(formatTime(trip!.start, AMS)).toBe("2026-10-12")
    expect(formatTime(trip!.end, AMS)).toBe("2026-10-15")
  })

  it("reads a zone Node does not know from the object's own VTIMEZONE", () => {
    const data = ics(
      "BEGIN:VTIMEZONE",
      "TZID:W. Europe Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:exchange",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;TZID=W. Europe Standard Time:20260710T100000",
      "DTEND;TZID=W. Europe Standard Time:20260710T110000",
      "SUMMARY:Review",
      "END:VEVENT",
    )
    const [review] = expandEvents(
      parseCalendarObject(data),
      range("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      AMS,
    ).occurrences

    expect(new Date(review!.startMs).toISOString()).toBe(
      "2026-07-10T08:00:00.000Z",
    )
  })

  it("says a rule in words", () => {
    expect(
      describeRule(
        ICAL.Recur.fromString("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5"),
      ),
    ).toBe("every 2 weeks on Monday and Wednesday, 5 times")
    expect(
      describeRule(
        ICAL.Recur.fromString("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231"),
      ),
    ).toBe("every month on the last Friday, until 2026-12-31")
  })
})

describe("writing events", () => {
  const start = parseTimeInput("2026-10-20T09:00", ZONE, "start")
  const end = parseTimeInput("2026-10-20T10:00", ZONE, "end")

  function series() {
    return newEventObject({
      uid: "S1",
      start,
      end,
      zone: ZONE,
      fields: {
        title: "Planning",
        location: "Room 4",
        alerts: [15],
        recurrence: { frequency: "weekly", count: 4 },
      },
    })
  }

  it("writes a timed event in its zone, with a VTIMEZONE and the alerts asked for", () => {
    const data = series()

    expect(data).toContain("DTSTART;TZID=Europe/Amsterdam:20261020T090000")
    expect(data).toContain("BEGIN:VTIMEZONE")
    expect(data).toContain("RRULE:FREQ=WEEKLY;COUNT=4")
    expect(data).toContain("TRIGGER:-PT15M")
    expect(
      starts(data, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ).toEqual([
      "2026-10-20T09:00:00+02:00",
      "2026-10-27T09:00:00+01:00",
      "2026-11-03T09:00:00+01:00",
      "2026-11-10T09:00:00+01:00",
    ])
  })

  it("changes one occurrence as an exception, leaving the series", () => {
    const changed = changeEvent(
      series(),
      {
        start: parseTimeInput("2026-10-27T15:00", ZONE, "start"),
        title: "Planning (late)",
      },
      {
        occurrence: "2026-10-27T08:00:00Z",
        scope: "this",
        fallback: AMS,
        zone: ZONE,
      },
    )

    expect(
      starts(changed, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ).toEqual([
      "2026-10-20T09:00:00+02:00",
      "2026-10-27T15:00:00+01:00",
      "2026-11-03T09:00:00+01:00",
      "2026-11-10T09:00:00+01:00",
    ])
    const moved = occurrenceOf(
      parseCalendarObject(changed),
      "2026-10-27T08:00:00Z",
      AMS,
    )!
    expect(moved.event.getFirstPropertyValue("summary")).toBe("Planning (late)")
    expect(formatTime(moved.end, AMS)).toBe("2026-10-27T16:00:00+01:00")
  })

  it("moves every occurrence by as much when one is moved for the whole series", () => {
    const changed = changeEvent(
      series(),
      { start: parseTimeInput("2026-10-28T11:00", ZONE, "start") },
      {
        occurrence: "2026-10-27T08:00:00Z",
        scope: "all",
        fallback: AMS,
        zone: ZONE,
      },
    )

    expect(
      starts(changed, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ).toEqual([
      "2026-10-21T11:00:00+02:00",
      "2026-10-28T11:00:00+01:00",
      "2026-11-04T11:00:00+01:00",
      "2026-11-11T11:00:00+01:00",
    ])
  })

  it("removes one occurrence with an EXDATE, and stops a series repeating", () => {
    const fewer = removeOccurrence(series(), "2026-11-03T08:00:00Z", AMS)
    expect(
      starts(fewer, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ).toHaveLength(3)

    const once = changeEvent(
      fewer,
      { recurrence: null },
      { occurrence: null, scope: "all", fallback: AMS, zone: ZONE },
    )
    expect(once).not.toMatch(/^RRULE:FREQ=WEEKLY/m)
    expect(once).not.toContain("EXDATE")
    expect(
      starts(once, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ).toEqual(["2026-10-20T09:00:00+02:00"])
  })

  it("keeps an event's length when only its start moves, and refuses one that would end first", () => {
    const one = newEventObject({
      uid: "E1",
      start,
      end,
      zone: ZONE,
      fields: { title: "Call" },
    })
    const later = changeEvent(
      one,
      { start: parseTimeInput("2026-10-21T13:30", ZONE, "start") },
      { occurrence: null, scope: "all", fallback: AMS, zone: ZONE },
    )
    const occurrence = occurrenceOf(parseCalendarObject(later), null, AMS)!
    expect(formatTime(occurrence.end, AMS)).toBe("2026-10-21T14:30:00+02:00")

    expect(() =>
      changeEvent(
        one,
        { end: parseTimeInput("2026-10-20T08:00", ZONE, "end") },
        { occurrence: null, scope: "all", fallback: AMS, zone: ZONE },
      ),
    ).toThrow(/end before it starts/)
  })

  it("keeps what it does not know about", () => {
    const data = ics(
      "BEGIN:VEVENT",
      "UID:keep",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20261020T070000Z",
      "DTEND:20261020T080000Z",
      "SUMMARY:Lunch",
      "ATTENDEE;CN=Ada;PARTSTAT=ACCEPTED:mailto:ada@example.com",
      "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
      "END:VEVENT",
    )
    const changed = changeEvent(
      data,
      { title: "Long lunch" },
      { occurrence: null, scope: "all", fallback: AMS, zone: ZONE },
    )

    expect(changed).toContain("SUMMARY:Long lunch")
    expect(changed).toContain("mailto:ada@example.com")
    expect(changed).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC")
  })

  it("reads times as asked: a date, a wall time in the zone, or an instant", () => {
    expect(parseTimeInput("2026-10-12", ZONE, "x")).toEqual({
      kind: "date",
      date: { year: 2026, month: 10, day: 12 },
    })
    expect(parseTimeInput("2026-10-12T09:15:00Z", ZONE, "x")).toMatchObject({
      kind: "time",
      wall: { hour: 11, minute: 15 },
      zone: ZONE,
    })
    expect(() => parseTimeInput("2026-02-30", ZONE, "x")).toThrow(
      /does not exist|not a date/,
    )
    expect(() => parseTimeInput("next tuesday", ZONE, "x")).toThrow(
      /give a date/,
    )
  })
})

describe("reminders", () => {
  it("writes a reminder with a due time, a priority and an alert", () => {
    const data = newReminderObject({
      uid: "R1",
      zone: ZONE,
      fallback: AMS,
      fields: {
        title: "Call Ada",
        due: parseTimeInput("2026-10-12T17:00", ZONE, "due"),
        priority: "high",
        alert: true,
      },
    })
    const reminder = readReminder(parseCalendarObject(data), AMS)!

    expect(reminder).toMatchObject({
      title: "Call Ada",
      priority: "high",
      completed: false,
    })
    expect(formatTime(reminder.due!, AMS)).toBe("2026-10-12T17:00:00+02:00")
    expect(data).toContain("TRIGGER;VALUE=DATE-TIME:20261012T150000Z")
  })

  it("completes a reminder, and opens it again", () => {
    const data = newReminderObject({
      uid: "R2",
      zone: ZONE,
      fallback: AMS,
      fields: { title: "Pay rent" },
    })
    const done = completeReminder(data, true, AMS)

    expect(done.next).toBeNull()
    expect(readReminder(parseCalendarObject(done.data), AMS)).toMatchObject({
      completed: true,
    })
    expect(done.data).toContain("STATUS:COMPLETED")

    const open = completeReminder(done.data, false, AMS)
    expect(readReminder(parseCalendarObject(open.data), AMS)).toMatchObject({
      completed: false,
    })
    expect(open.data).not.toMatch(/^COMPLETED:/m)
  })

  it("moves a repeating reminder on to its next due date instead of closing it", () => {
    const data = newReminderObject({
      uid: "R3",
      zone: ZONE,
      fallback: AMS,
      fields: {
        title: "Water the plants",
        due: parseTimeInput("2026-10-12", ZONE, "due"),
        recurrence: { frequency: "weekly" },
      },
    })
    const done = completeReminder(data, true, AMS)
    const reminder = readReminder(parseCalendarObject(done.data), AMS)!

    expect(reminder.completed).toBe(false)
    expect(formatTime(reminder.due!, AMS)).toBe("2026-10-19")
    expect(formatTime(done.next!, AMS)).toBe("2026-10-19")
  })

  it("clears a due date and its repetition together", () => {
    const data = newReminderObject({
      uid: "R4",
      zone: ZONE,
      fallback: AMS,
      fields: {
        title: "Stretch",
        due: parseTimeInput("2026-10-12", ZONE, "due"),
        recurrence: { frequency: "daily" },
      },
    })
    const changed = changeReminder(
      data,
      { due: null },
      { zone: ZONE, fallback: AMS },
    )

    expect(readReminder(parseCalendarObject(changed), AMS)).toMatchObject({
      due: null,
      recurring: false,
    })
  })
})
