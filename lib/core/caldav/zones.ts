import ICAL from "ical.js"

/**
 * Time zones for calendar accounts. iCalendar writes most times as a wall
 * clock in a named zone (DTSTART;TZID=Europe/Amsterdam:20261012T090000), and
 * a recurring event repeats in that wall clock, across summer time. PCP turns
 * those into instants itself rather than through ical.js's global zone
 * registry: an IANA name through the Intl database Node carries, anything
 * else (an Exchange zone like "W. Europe Standard Time") through the
 * VTIMEZONE the calendar object sent with it.
 *
 * Writing, PCP names an IANA zone and adds a VTIMEZONE for it (RFC 5545
 * 3.6.5 asks for one per TZID), made from the same database: yearly rules
 * when the zone's changes follow one (the second Sunday in March), its
 * changes year by year otherwise.
 */

/** A wall-clock time, with no zone: months 1 to 12. */
export type Wall = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export type Zone = {
  /** The TZID as the calendar names it. */
  name: string
  /** Minutes east of UTC at an instant. */
  offsetAt(instant: number): number
}

const MINUTE = 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone)

  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(zone, found)
  }

  return found
}

/** The IANA zone's canonical spelling, or null when Node does not know it. */
export function ianaZone(name: string): string | null {
  const trimmed = name.trim()

  if (!trimmed || trimmed.length > 100) {
    return null
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: trimmed,
    }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The zone this machine runs in: what a time without one means. */
export function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

export function wallToUtcMs(wall: Wall): number {
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  )
}

export function utcMsToWall(ms: number): Wall {
  const date = new Date(ms)

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  }
}

function intlOffset(zone: string, instant: number): number {
  const parts = formatter(zone).formatToParts(new Date(instant))
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  )

  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / MINUTE)
}

export function intlZone(name: string): Zone {
  return { name, offsetAt: (instant) => intlOffset(name, instant) }
}

export const UTC_ZONE: Zone = { name: "UTC", offsetAt: () => 0 }

/**
 * A zone from a VTIMEZONE the calendar sent, for a TZID Node does not know.
 * ical.js reads its rules; it is asked with a wall time, so an instant is
 * turned into one by trying the offset it gives until it holds.
 */
export function vtimezoneZone(name: string, component: ICAL.Component): Zone {
  const zone = new ICAL.Timezone({ component, tzid: name })
  const atWall = (wall: Wall) =>
    Math.round(zone.utcOffset(ICAL.Time.fromData(wall)) / 60)

  return {
    name,
    offsetAt(instant) {
      let offset = atWall(utcMsToWall(instant))

      for (let i = 0; i < 2; i++) {
        const next = atWall(utcMsToWall(instant + offset * MINUTE))

        if (next === offset) {
          break
        }

        offset = next
      }

      return offset
    },
  }
}

/**
 * The instant a wall time in a zone stands for. A time summer time skips
 * (02:30 on the morning the clocks go forward) is read with the offset from
 * before the change, so it lands an hour later, as calendar apps do; a time
 * that happens twice is the first.
 */
export function wallToInstant(zone: Zone, wall: Wall): number {
  const local = wallToUtcMs(wall)
  const before = zone.offsetAt(local - 36 * 60 * MINUTE)
  const after = zone.offsetAt(local + 36 * 60 * MINUTE)

  // The offsets around it, earlier first: the first that maps back to the
  // same wall time wins.
  for (const offset of before === after ? [before] : [before, after]) {
    const instant = local - offset * MINUTE

    if (zone.offsetAt(instant) === offset) {
      return instant
    }
  }

  return local - before * MINUTE
}

export function instantToWall(zone: Zone, instant: number): Wall {
  return utcMsToWall(instant + zone.offsetAt(instant) * MINUTE)
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 2026-10-12T09:00:00+02:00: an instant as the zone's wall clock shows it. */
export function formatInZone(zone: Zone, instant: number): string {
  const offset = zone.offsetAt(instant)
  const wall = utcMsToWall(instant + offset * MINUTE)

  return `${formatDate(wall)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${offset === 0 && zone.name === "UTC" ? "Z" : offsetText(offset)}`
}

/** 2026-10-12. */
export function formatDate(wall: Pick<Wall, "year" | "month" | "day">): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
}

/** The date a day later (or earlier, with a negative count). */
export function addDays(
  date: Pick<Wall, "year" | "month" | "day">,
  days: number,
): Pick<Wall, "year" | "month" | "day"> {
  const ms = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000
  const wall = utcMsToWall(ms)
  return { year: wall.year, month: wall.month, day: wall.day }
}

// ---------------------------------------------------------------------------
// VTIMEZONE from the Intl database

type Transition = {
  /** The instant the offset changes. */
  at: number
  from: number
  to: number
}

/** The changes of offset in a year, found by days and then by minutes. */
function transitionsIn(zone: Zone, year: number): Transition[] {
  const out: Transition[] = []
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  const step = 86_400_000
  let previous = zone.offsetAt(start)

  for (let at = start + step; at <= end; at += step) {
    const offset = zone.offsetAt(at)

    if (offset === previous) {
      continue
    }

    let low = at - step
    let high = at

    while (high - low > MINUTE) {
      const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE

      if (zone.offsetAt(middle) === previous) {
        low = middle
      } else {
        high = middle
      }
    }

    out.push({ at: high, from: previous, to: offset })
    previous = offset
  }

  return out
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const

/** "2SU" or "-1SU": which weekday of its month a local date is. */
function weekdayRule(wall: Wall): string {
  const weekday = new Date(wallToUtcMs(wall)).getUTCDay()
  const lastDay = new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate()

  return wall.day + 7 > lastDay
    ? `-1${WEEKDAYS[weekday]}`
    : `${Math.ceil(wall.day / 7)}${WEEKDAYS[weekday]}`
}

function icsLocal(wall: Wall): string {
  return `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`
}

function icsOffset(minutes: number): string {
  return offsetText(minutes).replace(":", "")
}

/** A transition's onset as the zone's clock read just before it. */
function onset(transition: Transition): Wall {
  return utcMsToWall(transition.at + transition.from * MINUTE)
}

function sameRule(a: Transition, b: Transition): boolean {
  const left = onset(a)
  const right = onset(b)

  return (
    a.from === b.from &&
    a.to === b.to &&
    left.month === right.month &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    weekdayRule(left) === weekdayRule(right)
  )
}

function observance(
  transition: Transition,
  extra: string[],
  daylight: boolean,
): string[] {
  const kind = daylight ? "DAYLIGHT" : "STANDARD"

  return [
    `BEGIN:${kind}`,
    `DTSTART:${icsLocal(onset(transition))}`,
    `TZOFFSETFROM:${icsOffset(transition.from)}`,
    `TZOFFSETTO:${icsOffset(transition.to)}`,
    ...extra,
    `END:${kind}`,
  ]
}

/**
 * A VTIMEZONE for an IANA zone, good for events around `year`. A zone whose
 * changes follow the same yearly rule from the year before to three years
 * on gets that rule, from the year before; one that does not, its changes
 * from the year before to twenty years on, one by one.
 */
export function buildVtimezone(name: string, year: number): string {
  const zone = intlZone(name)
  const lines = ["BEGIN:VTIMEZONE", `TZID:${name}`]
  // Rules start a year early, so the whole of `year` has an observance.
  const first = transitionsIn(zone, year - 1)

  if (first.length === 0) {
    const offset = zone.offsetAt(Date.UTC(year, 0, 1))

    lines.push(
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${icsOffset(offset)}`,
      `TZOFFSETTO:${icsOffset(offset)}`,
      "END:STANDARD",
    )
  } else {
    const later = [0, 1, 2, 3].map((n) => transitionsIn(zone, year + n))
    const yearly =
      first.length === 2 &&
      later.every(
        (transitions) =>
          transitions.length === 2 &&
          transitions.every((t, i) => sameRule(t, first[i]!)),
      )

    if (yearly) {
      for (const transition of first) {
        const wall = onset(transition)

        lines.push(
          ...observance(
            transition,
            [
              `RRULE:FREQ=YEARLY;BYMONTH=${wall.month};BYDAY=${weekdayRule(wall)}`,
            ],
            transition.to > transition.from,
          ),
        )
      }
    } else {
      for (let y = year - 1; y <= year + 20; y++) {
        for (const transition of y === year - 1
          ? first
          : transitionsIn(zone, y)) {
          lines.push(
            ...observance(transition, [], transition.to > transition.from),
          )
        }
      }
    }
  }

  lines.push("END:VTIMEZONE")
  return lines.join("\r\n")
}
