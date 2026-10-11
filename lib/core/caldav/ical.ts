import ICAL from "ical.js"

import { MAX_RECURRENCE_STEPS } from "./limits"
import { DavRequestError } from "./types"
import {
  addDays,
  formatDate,
  formatInZone,
  ianaZone,
  instantToWall,
  intlZone,
  UTC_ZONE,
  vtimezoneZone,
  wallToInstant,
  wallToUtcMs,
  type Wall,
  type Zone,
} from "./zones"

/**
 * Reading iCalendar (RFC 5545) as a calendar account holds it: one calendar
 * object per event or reminder, with a recurring event's exceptions inside
 * it. ical.js parses the text and steps through recurrence rules in wall
 * time, as the RFC has them repeat; PCP turns wall times into instants with
 * its own zones (zones.ts), so a server's VTIMEZONE never changes how another
 * account's times read.
 */

export type DateOnly = Pick<Wall, "year" | "month" | "day">

/** A DATE (an all-day value) or a DATE-TIME in a zone. */
export type TimeValue =
  | { kind: "date"; date: DateOnly }
  | {
      kind: "time"
      wall: Wall
      /** The zone its wall time is in: UTC for a Z time. */
      zone: Zone
      /** The TZID it was written with; null for UTC or floating. */
      tzid: string | null
    }

export function parseCalendar(data: string): ICAL.Component {
  let component: ICAL.Component

  try {
    component = new ICAL.Component(ICAL.parse(data) as unknown[])
  } catch {
    throw new DavRequestError(
      "The calendar server holds something here that is not iCalendar.",
    )
  }

  if (component.name !== "vcalendar") {
    throw new DavRequestError(
      "The calendar server holds something here that is not a calendar object.",
    )
  }

  return component
}

/**
 * The zones a calendar object's TZIDs name: an IANA zone Node knows (also
 * when a client prefixed it, as "/mozilla.org/20050126_1/Europe/Berlin"),
 * else the object's own VTIMEZONE, else `fallback`.
 */
export function zoneBook(
  calendar: ICAL.Component,
  fallback: Zone,
): (tzid: string) => Zone {
  const cache = new Map<string, Zone>()

  return (tzid) => {
    const known = cache.get(tzid)

    if (known) {
      return known
    }

    let zone: Zone | null = null
    const segments = tzid.split("/").filter(Boolean)

    for (let take = Math.min(3, segments.length); take >= 1 && !zone; take--) {
      const name = ianaZone(segments.slice(-take).join("/"))

      if (name && (take === segments.length || take >= 2)) {
        zone = name === "UTC" || name === "Etc/UTC" ? UTC_ZONE : intlZone(name)
      }
    }

    if (!zone) {
      const vtimezone = calendar
        .getAllSubcomponents("vtimezone")
        .find((candidate) => candidate.getFirstPropertyValue("tzid") === tzid)

      if (vtimezone) {
        try {
          zone = vtimezoneZone(tzid, vtimezone)
        } catch {
          zone = null
        }
      }
    }

    const found = zone ?? fallback
    cache.set(tzid, found)
    return found
  }
}

function wallOf(time: ICAL.Time): Wall {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  }
}

function isUtc(time: ICAL.Time): boolean {
  return time.zone === ICAL.Timezone.utcTimezone
}

/** One ICAL.Time of a property, read with the property's TZID. */
export function readTimeValue(
  time: ICAL.Time,
  tzid: string | null,
  resolve: (tzid: string) => Zone,
  fallback: Zone,
): TimeValue {
  if (time.isDate) {
    return {
      kind: "date",
      date: { year: time.year, month: time.month, day: time.day },
    }
  }

  if (isUtc(time)) {
    return { kind: "time", wall: wallOf(time), zone: UTC_ZONE, tzid: null }
  }

  return tzid
    ? { kind: "time", wall: wallOf(time), zone: resolve(tzid), tzid }
    : { kind: "time", wall: wallOf(time), zone: fallback, tzid: null }
}

export function readTime(
  component: ICAL.Component,
  name: string,
  resolve: (tzid: string) => Zone,
  fallback: Zone,
): TimeValue | null {
  const property = component.getFirstProperty(name)
  const value = property?.getFirstValue()

  if (!property || !(value instanceof ICAL.Time)) {
    return null
  }

  return readTimeValue(
    value,
    (property.getParameter("tzid") as string | undefined) ?? null,
    resolve,
    fallback,
  )
}

/** Every value of a multi-valued time property (EXDATE, RDATE). */
function readTimes(
  component: ICAL.Component,
  name: string,
  resolve: (tzid: string) => Zone,
  fallback: Zone,
): TimeValue[] {
  const out: TimeValue[] = []

  for (const property of component.getAllProperties(name)) {
    const tzid = (property.getParameter("tzid") as string | undefined) ?? null

    for (const value of property.getValues()) {
      if (value instanceof ICAL.Time) {
        out.push(readTimeValue(value, tzid, resolve, fallback))
      }
    }
  }

  return out
}

/** The instant a value starts at; a date starts at midnight in `dayZone`. */
export function instantOf(value: TimeValue, dayZone: Zone): number {
  if (value.kind === "date") {
    return wallToInstant(dayZone, {
      ...value.date,
      hour: 0,
      minute: 0,
      second: 0,
    })
  }

  return value.zone === UTC_ZONE
    ? wallToUtcMs(value.wall)
    : wallToInstant(value.zone, value.wall)
}

/**
 * What a value is called in an answer: a date as 2026-10-12, a time with
 * its offset in its own zone (a UTC time in `display`).
 */
export function formatTime(value: TimeValue, display: Zone): string {
  if (value.kind === "date") {
    return formatDate(value.date)
  }

  const zone = value.zone === UTC_ZONE ? display : value.zone
  return formatInZone(zone, instantOf(value, display))
}

/**
 * The key an occurrence is matched by (a RECURRENCE-ID, an EXDATE): its
 * date, or its instant.
 */
export function occurrenceKey(value: TimeValue, dayZone: Zone): string {
  return value.kind === "date"
    ? formatDate(value.date)
    : new Date(instantOf(value, dayZone)).toISOString().replace(/\.000Z$/, "Z")
}

/** An occurrence id an assistant passes back, as a key; null if malformed. */
export function parseOccurrenceKey(raw: string): string | null {
  const text = raw.trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text
  }

  const ms = Date.parse(text)

  return Number.isNaN(ms) || !/T/.test(text)
    ? null
    : new Date(ms).toISOString().replace(/\.000Z$/, "Z")
}

// ---------------------------------------------------------------------------
// Events and their occurrences

export type Occurrence = {
  /** The series' master (or a lone exception when there is none). */
  master: ICAL.Component
  /** The VEVENT whose details this occurrence has: an exception, or master. */
  event: ICAL.Component
  start: TimeValue
  end: TimeValue
  startMs: number
  endMs: number
  /** For an occurrence of a series: its original start, as a key. */
  occurrence: string | null
  recurring: boolean
}

type Range = { from: number; to: number }

function overlaps(startMs: number, endMs: number, range: Range): boolean {
  return endMs > startMs
    ? startMs < range.to && endMs > range.from
    : startMs >= range.from && startMs < range.to
}

/** A VEVENT's end: DTEND, else DTSTART plus DURATION, else its default. */
export function eventEnd(
  event: ICAL.Component,
  start: TimeValue,
  resolve: (tzid: string) => Zone,
  fallback: Zone,
): TimeValue {
  const end = readTime(event, "dtend", resolve, fallback)

  if (end && end.kind === start.kind) {
    return end
  }

  const duration = event.getFirstPropertyValue("duration")
  const seconds = duration instanceof ICAL.Duration ? duration.toSeconds() : 0

  if (start.kind === "date") {
    // An all-day event lasts its day unless it says longer.
    return {
      kind: "date",
      date: addDays(start.date, Math.max(1, Math.round(seconds / 86_400))),
    }
  }

  const ms = instantOf(start, fallback) + seconds * 1000
  return {
    kind: "time",
    wall: instantToWall(start.zone, ms),
    zone: start.zone,
    tzid: start.tzid,
  }
}

/** A value moved to another start, keeping its kind and zone. */
function shifted(value: TimeValue, startMs: number, dayZone: Zone): TimeValue {
  if (value.kind === "date") {
    const wall = instantToWall(dayZone, startMs)
    return {
      kind: "date",
      date: { year: wall.year, month: wall.month, day: wall.day },
    }
  }

  return { ...value, wall: instantToWall(value.zone, startMs) }
}

function dayCount(from: DateOnly, to: DateOnly): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000,
  )
}

/** Whether a VEVENT or VTODO repeats: an RRULE or RDATE. */
export function isRecurring(component: ICAL.Component): boolean {
  return component.hasProperty("rrule") || component.hasProperty("rdate")
}

/**
 * The starts of a series, as values in DTSTART's zone, from its RRULEs and
 * RDATEs, without its EXDATEs, up to `until` (an instant). Stops after
 * MAX_RECURRENCE_STEPS; `cut` says whether it did.
 */
export function seriesStarts(
  master: ICAL.Component,
  start: TimeValue,
  untilMs: number,
  resolve: (tzid: string) => Zone,
  fallback: Zone,
): { starts: TimeValue[]; cut: boolean } {
  const dtstart = master.getFirstPropertyValue("dtstart")

  if (!(dtstart instanceof ICAL.Time)) {
    return { starts: [start], cut: false }
  }

  const found = new Map<string, TimeValue>()
  const excluded = new Set(
    readTimes(master, "exdate", resolve, fallback).map((value) =>
      occurrenceKey(value, fallback),
    ),
  )
  let cut = false
  let steps = 0

  const add = (value: TimeValue) => {
    const key = occurrenceKey(value, fallback)

    if (!excluded.has(key)) {
      found.set(key, value)
    }
  }

  // DTSTART is always the first occurrence (RFC 5545 3.8.5.3).
  add(start)

  for (const property of master.getAllProperties("rrule")) {
    const rule = property.getFirstValue()

    if (!(rule instanceof ICAL.Recur)) {
      continue
    }

    const recur = rule.clone()

    // An UNTIL in UTC bounds a series written in a zone by its instant: it
    // is stepped through in wall time, so UNTIL is made one too.
    if (
      recur.until &&
      !recur.until.isDate &&
      isUtc(recur.until) &&
      start.kind === "time" &&
      start.zone !== UTC_ZONE
    ) {
      const wall = instantToWall(start.zone, wallToUtcMs(wallOf(recur.until)))
      recur.until = ICAL.Time.fromData(wall)
    }

    const base =
      start.kind === "time" && start.zone === UTC_ZONE
        ? ICAL.Time.fromData(start.wall, ICAL.Timezone.utcTimezone)
        : start.kind === "time"
          ? ICAL.Time.fromData(start.wall)
          : ICAL.Time.fromData({ ...start.date, isDate: true })
    const iterator = recur.iterator(base)

    for (;;) {
      if (++steps > MAX_RECURRENCE_STEPS) {
        cut = true
        break
      }

      const next = iterator.next()

      if (!next) {
        break
      }

      const value: TimeValue =
        start.kind === "date"
          ? {
              kind: "date",
              date: { year: next.year, month: next.month, day: next.day },
            }
          : { ...start, wall: wallOf(next) }

      if (instantOf(value, fallback) >= untilMs) {
        break
      }

      add(value)
    }
  }

  for (const value of readTimes(master, "rdate", resolve, fallback)) {
    if (value.kind === start.kind) {
      add(value)
    }
  }

  return {
    starts: [...found.values()].sort(
      (a, b) => instantOf(a, fallback) - instantOf(b, fallback),
    ),
    cut,
  }
}

/**
 * The occurrences of the events in one calendar object that overlap a
 * range: a lone event once, a series once per occurrence with its
 * exceptions in place of the occurrences they change. Cancelled exceptions
 * are kept (the caller decides); EXDATEs are gone.
 */
export function expandEvents(
  calendar: ICAL.Component,
  range: Range,
  fallback: Zone,
): { occurrences: Occurrence[]; cut: boolean } {
  const resolve = zoneBook(calendar, fallback)
  const events = calendar.getAllSubcomponents("vevent")
  const masters = events.filter((event) => !event.hasProperty("recurrence-id"))
  const exceptions = events.filter((event) =>
    event.hasProperty("recurrence-id"),
  )
  const out: Occurrence[] = []
  let cut = false

  const push = (
    master: ICAL.Component,
    event: ICAL.Component,
    start: TimeValue,
    end: TimeValue,
    occurrence: string | null,
    recurring: boolean,
  ) => {
    const startMs = instantOf(start, fallback)
    const endMs = instantOf(end, fallback)

    if (overlaps(startMs, endMs, range)) {
      out.push({
        master,
        event,
        start,
        end,
        startMs,
        endMs,
        occurrence,
        recurring,
      })
    }
  }

  for (const master of masters) {
    const start = readTime(master, "dtstart", resolve, fallback)

    if (!start) {
      continue
    }

    const end = eventEnd(master, start, resolve, fallback)

    if (!isRecurring(master)) {
      push(master, master, start, end, null, false)
      continue
    }

    const changed = new Map<string, ICAL.Component>()

    for (const exception of exceptions) {
      const id = readTime(exception, "recurrence-id", resolve, fallback)

      if (
        id &&
        exception.getFirstPropertyValue("uid") ===
          master.getFirstPropertyValue("uid")
      ) {
        changed.set(occurrenceKey(id, fallback), exception)
      }
    }

    const length =
      start.kind === "date" && end.kind === "date"
        ? dayCount(start.date, end.date)
        : instantOf(end, fallback) - instantOf(start, fallback)
    // Occurrences that start before the range can still run into it.
    const series = seriesStarts(master, start, range.to, resolve, fallback)
    cut ||= series.cut

    for (const value of series.starts) {
      const key = occurrenceKey(value, fallback)
      const exception = changed.get(key)

      if (exception) {
        const own = readTime(exception, "dtstart", resolve, fallback) ?? value
        push(
          master,
          exception,
          own,
          eventEnd(exception, own, resolve, fallback),
          key,
          true,
        )
        changed.delete(key)
        continue
      }

      const occurrenceEnd: TimeValue =
        value.kind === "date"
          ? { kind: "date", date: addDays(value.date, length) }
          : shifted(end, instantOf(value, fallback) + length, fallback)
      push(master, master, value, occurrenceEnd, key, true)
    }

    // An exception for an occurrence the rule does not give (moved in from
    // past the range's end, or an RDATE written later) still shows.
    for (const [key, exception] of changed) {
      const own = readTime(exception, "dtstart", resolve, fallback)

      if (own) {
        push(
          master,
          exception,
          own,
          eventEnd(exception, own, resolve, fallback),
          key,
          true,
        )
      }
    }
  }

  // Exceptions with no master in this object (an invitation to one
  // occurrence of someone else's series) stand alone.
  for (const exception of exceptions) {
    const uid = exception.getFirstPropertyValue("uid")

    if (masters.some((master) => master.getFirstPropertyValue("uid") === uid)) {
      continue
    }

    const start = readTime(exception, "dtstart", resolve, fallback)
    const id = readTime(exception, "recurrence-id", resolve, fallback)

    if (start) {
      push(
        exception,
        exception,
        start,
        eventEnd(exception, start, resolve, fallback),
        id ? occurrenceKey(id, fallback) : null,
        true,
      )
    }
  }

  return { occurrences: out, cut }
}

// ---------------------------------------------------------------------------
// Reading the details

function text(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name)
  return typeof value === "string" && value.trim() ? value : null
}

function mailto(value: unknown): string | null {
  return typeof value === "string"
    ? value.replace(/^mailto:/i, "").trim() || null
    : null
}

const WEEKDAY_NAMES: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
}
const ORDINALS: Record<string, string> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "5": "fifth",
  "-1": "last",
  "-2": "second to last",
}
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]
const UNITS: Record<string, string> = {
  SECONDLY: "second",
  MINUTELY: "minute",
  HOURLY: "hour",
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
}

function list(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** "every 2 weeks on Tuesday and Thursday, 5 times": a rule in words. */
export function describeRule(recur: ICAL.Recur): string {
  const unit = UNITS[recur.freq] ?? "time"
  const interval = recur.interval ?? 1
  const parts = [
    interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`,
  ]
  const byDay = (recur.parts.BYDAY ?? []) as string[]
  const byMonthDay = (recur.parts.BYMONTHDAY ?? []) as number[]
  const byMonth = (recur.parts.BYMONTH ?? []) as number[]

  if (byDay.length > 0) {
    const days = byDay.map((entry) => {
      const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(String(entry))
      const name = WEEKDAY_NAMES[match?.[2] ?? ""] ?? String(entry)
      const nth = match?.[1] ? ORDINALS[String(Number(match[1]))] : null
      return nth ? `the ${nth} ${name}` : name
    })
    parts.push(`on ${list(days)}`)
  }

  if (byMonthDay.length > 0) {
    parts.push(
      `on day ${list(byMonthDay.map((day) => (Number(day) === -1 ? "last" : String(day))))}`,
    )
  }

  if (byMonth.length > 0) {
    parts.push(
      `in ${list(byMonth.map((month) => MONTH_NAMES[Number(month) - 1] ?? String(month)))}`,
    )
  }

  let summary = parts.join(" ")

  if (recur.count) {
    summary += `, ${recur.count} time${recur.count === 1 ? "" : "s"}`
  } else if (recur.until) {
    summary += `, until ${recur.until.isDate ? recur.until.toString() : recur.until.toString().slice(0, 10)}`
  }

  return summary
}

export type RuleView = { rule: string; summary: string }

export function ruleOf(component: ICAL.Component): RuleView | null {
  const recur = component.getFirstPropertyValue("rrule")

  if (!(recur instanceof ICAL.Recur)) {
    return component.hasProperty("rdate")
      ? { rule: "", summary: "on dates the event lists" }
      : null
  }

  return { rule: recur.toString(), summary: describeRule(recur) }
}

/**
 * Alerts as minutes before the start (a VTODO's: before its due time), and
 * the ones set at a time of their own.
 */
export function alertsOf(component: ICAL.Component): {
  minutesBefore: number[]
  at: string[]
} {
  const minutesBefore: number[] = []
  const at: string[] = []

  for (const alarm of component.getAllSubcomponents("valarm")) {
    const trigger = alarm.getFirstProperty("trigger")
    const value = trigger?.getFirstValue()

    if (value instanceof ICAL.Duration) {
      minutesBefore.push(Math.round(-value.toSeconds() / 60))
    } else if (value instanceof ICAL.Time) {
      at.push(value.toString())
    }
  }

  return { minutesBefore: minutesBefore.sort((a, b) => a - b), at }
}

export type EventDetails = {
  title: string
  location: string | null
  notes: string | null
  url: string | null
  status: "confirmed" | "tentative" | "cancelled" | null
  availability: "busy" | "free"
  organizer: { name: string | null; email: string | null } | null
  attendees: Array<{
    name: string | null
    email: string | null
    response: string | null
    role: string | null
  }>
  alerts: number[]
  categories: string[]
}

export function eventDetails(event: ICAL.Component): EventDetails {
  const status = text(event, "status")?.toLowerCase() ?? null
  const organizer = event.getFirstProperty("organizer")

  return {
    title: text(event, "summary") ?? "",
    location: text(event, "location"),
    notes: text(event, "description"),
    url: text(event, "url"),
    status:
      status === "confirmed" || status === "tentative" || status === "cancelled"
        ? status
        : null,
    availability:
      text(event, "transp")?.toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    organizer: organizer
      ? {
          name: (organizer.getParameter("cn") as string | undefined) ?? null,
          email: mailto(organizer.getFirstValue()),
        }
      : null,
    attendees: event.getAllProperties("attendee").map((attendee) => ({
      name: (attendee.getParameter("cn") as string | undefined) ?? null,
      email: mailto(attendee.getFirstValue()),
      response:
        (
          attendee.getParameter("partstat") as string | undefined
        )?.toLowerCase() ?? null,
      role:
        (attendee.getParameter("role") as string | undefined)?.toLowerCase() ??
        null,
    })),
    alerts: alertsOf(event).minutesBefore,
    categories: event
      .getAllProperties("categories")
      .flatMap((property) => property.getValues())
      .map(String)
      .filter(Boolean),
  }
}

// ---------------------------------------------------------------------------
// Reminders (VTODO)

export type ReminderView = {
  todo: ICAL.Component
  title: string
  notes: string | null
  url: string | null
  due: TimeValue | null
  start: TimeValue | null
  completed: boolean
  completedAt: string | null
  priority: "high" | "medium" | "low" | null
  recurring: boolean
}

/** The VTODO a reminder's object is about: its master, or its first. */
export function mainTodo(calendar: ICAL.Component): ICAL.Component | null {
  const todos = calendar.getAllSubcomponents("vtodo")
  return (
    todos.find((todo) => !todo.hasProperty("recurrence-id")) ?? todos[0] ?? null
  )
}

export function priorityName(value: unknown): ReminderView["priority"] {
  const number = Number(value)

  if (!Number.isInteger(number) || number <= 0 || number > 9) {
    return null
  }

  return number < 5 ? "high" : number === 5 ? "medium" : "low"
}

export function readReminder(
  calendar: ICAL.Component,
  fallback: Zone,
): ReminderView | null {
  const todo = mainTodo(calendar)

  if (!todo) {
    return null
  }

  const resolve = zoneBook(calendar, fallback)
  const status = text(todo, "status")?.toUpperCase()
  const completedAt = todo.getFirstPropertyValue("completed")

  return {
    todo,
    title: text(todo, "summary") ?? "",
    notes: text(todo, "description"),
    url: text(todo, "url"),
    due: readTime(todo, "due", resolve, fallback),
    start: readTime(todo, "dtstart", resolve, fallback),
    completed: status === "COMPLETED" || completedAt instanceof ICAL.Time,
    completedAt:
      completedAt instanceof ICAL.Time
        ? formatTime(
            readTimeValue(completedAt, null, resolve, fallback),
            fallback,
          )
        : null,
    priority: priorityName(todo.getFirstPropertyValue("priority")),
    recurring: isRecurring(todo),
  }
}

/**
 * One occurrence of a series by its key (an exception's own times when it
 * has one), or a lone event's only one when `key` is null; a series with
 * no key reads as its first occurrence. Null when there is no such
 * occurrence.
 */
export function occurrenceOf(
  calendar: ICAL.Component,
  key: string | null,
  fallback: Zone,
): Occurrence | null {
  const resolve = zoneBook(calendar, fallback)
  const master =
    calendar
      .getAllSubcomponents("vevent")
      .find((event) => !event.hasProperty("recurrence-id")) ?? null

  if (key === null) {
    const event = master ?? calendar.getFirstSubcomponent("vevent")
    const start = event ? readTime(event, "dtstart", resolve, fallback) : null

    if (!event || !start) {
      return null
    }

    const end = eventEnd(event, start, resolve, fallback)

    return {
      master: event,
      event,
      start,
      end,
      startMs: instantOf(start, fallback),
      endMs: instantOf(end, fallback),
      occurrence: null,
      recurring: isRecurring(event),
    }
  }

  const keyMs =
    key.length === 10
      ? Date.UTC(
          Number(key.slice(0, 4)),
          Number(key.slice(5, 7)) - 1,
          Number(key.slice(8, 10)),
        )
      : Date.parse(key)

  if (Number.isNaN(keyMs)) {
    return null
  }

  const { occurrences } = expandEvents(
    calendar,
    { from: Number.MIN_SAFE_INTEGER, to: keyMs + 2 * 86_400_000 },
    fallback,
  )

  return occurrences.find((found) => found.occurrence === key) ?? null
}
