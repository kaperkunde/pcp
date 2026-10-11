import ICAL from "ical.js"
import { describe, expect, it } from "vitest"

import {
  buildVtimezone,
  formatInZone,
  ianaZone,
  instantToWall,
  intlZone,
  vtimezoneZone,
  wallToInstant,
} from "./zones"

const AMSTERDAM = intlZone("Europe/Amsterdam")

describe("wall times and instants", () => {
  it("reads a wall time with the offset in force then", () => {
    expect(
      new Date(
        wallToInstant(AMSTERDAM, {
          year: 2026,
          month: 7,
          day: 1,
          hour: 9,
          minute: 0,
          second: 0,
        }),
      ).toISOString(),
    ).toBe("2026-07-01T07:00:00.000Z")
    expect(
      new Date(
        wallToInstant(AMSTERDAM, {
          year: 2026,
          month: 12,
          day: 1,
          hour: 9,
          minute: 0,
          second: 0,
        }),
      ).toISOString(),
    ).toBe("2026-12-01T08:00:00.000Z")
  })

  it("moves a time the clocks skip an hour on, and takes the first of a repeated one", () => {
    // 29 March 2026: 02:00 becomes 03:00 in Amsterdam.
    expect(
      formatInZone(
        AMSTERDAM,
        wallToInstant(AMSTERDAM, {
          year: 2026,
          month: 3,
          day: 29,
          hour: 2,
          minute: 30,
          second: 0,
        }),
      ),
    ).toBe("2026-03-29T03:30:00+02:00")
    // 25 October 2026: 02:30 happens twice; the first is still summer time.
    expect(
      formatInZone(
        AMSTERDAM,
        wallToInstant(AMSTERDAM, {
          year: 2026,
          month: 10,
          day: 25,
          hour: 2,
          minute: 30,
          second: 0,
        }),
      ),
    ).toBe("2026-10-25T02:30:00+02:00")
  })

  it("turns an instant back into the zone's wall clock", () => {
    expect(
      instantToWall(intlZone("America/New_York"), Date.UTC(2026, 0, 15, 17)),
    ).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 12,
      minute: 0,
      second: 0,
    })
  })

  it("knows IANA names and nothing else", () => {
    expect(ianaZone("europe/amsterdam")).toBe("Europe/Amsterdam")
    expect(ianaZone("W. Europe Standard Time")).toBeNull()
    expect(ianaZone("")).toBeNull()
  })
})

describe("VTIMEZONE", () => {
  function roundTrip(name: string, year: number) {
    const text = buildVtimezone(name, year)
    const component = new ICAL.Component(
      ICAL.parse(`BEGIN:VCALENDAR\r\n${text}\r\nEND:VCALENDAR`) as unknown[],
    ).getFirstSubcomponent("vtimezone")!
    return { text, zone: vtimezoneZone(name, component) }
  }

  it("writes a zone with summer time as its yearly rules", () => {
    const { text } = roundTrip("Europe/Amsterdam", 2026)

    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU")
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU")
    expect(text).toContain("TZOFFSETTO:+0200")
  })

  it.each([
    "Europe/Amsterdam",
    "America/New_York",
    "Australia/Sydney",
    "Asia/Kolkata",
    "America/Sao_Paulo",
    "UTC",
  ])("gives %s the offsets Node's database does", (name) => {
    const { zone } = roundTrip(name, 2026)
    const reference = intlZone(name)

    for (let day = 0; day < 3 * 365; day += 11) {
      const instant = Date.UTC(2026, 0, 1, 12) + day * 86_400_000
      expect(zone.offsetAt(instant)).toBe(reference.offsetAt(instant))
    }
  })
})
