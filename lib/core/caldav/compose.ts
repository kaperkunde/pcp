import { randomUUID } from "node:crypto"

import ICAL from "ical.js"

import { invalid } from "../errors"
import { PCP_VERSION } from "../version"
import {
  eventEnd,
  instantOf,
  isRecurring,
  occurrenceKey,
  readTime,
  seriesStarts,
  zoneBook,
  type DateOnly,
  type TimeValue,
} from "./ical"
import { DavRequestError } from "./types"
import {
  addDays,
  buildVtimezone,
  ianaZone,
  instantToWall,
  intlZone,
  UTC_ZONE,
  wallToInstant,
  type Wall,
  type Zone,
} from "./zones"

/**
 * Writing iCalendar: new events and reminders, and changes to the ones a
 * calendar holds. A change is made to the object as the server sent it, so
 * whatever PCP does not know about (another app's properties, attendees,
 * attachments) stays as it was. Times PCP writes are in an IANA zone with a
 * VTIMEZONE for it, or dates for all-day values.
 */

const PRODID = `-//PCP//CalDAV ${PCP_VERSION}//EN`

/** A time as an assistant wrote it, read in `zone` when it names none. */
export type TimeInput =
  { kind: "date"; date: DateOnly } | { kind: "time"; wall: Wall; zone: string }

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    year >= 1900 &&
    year <= 2200 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/**
 * 2026-10-12 (a date), 2026-10-12T09:00 (a wall time in `zone`), or a time
 * with Z or an offset (that instant, as `zone`'s wall clock shows it).
 */
export function parseTimeInput(
  raw: string,
  zone: string,
  field: string,
): TimeInput {
  const text = raw.trim()
  const date = DATE.exec(text)

  if (date) {
    const [year, month, day] = [
      Number(date[1]),
      Number(date[2]),
      Number(date[3]),
    ]

    if (!validDate(year, month, day)) {
      throw invalid(`${field} is not a date that exists.`)
    }

    return { kind: "date", date: { year, month, day } }
  }

  const local = LOCAL.exec(text)

  if (local) {
    const [year, month, day] = [
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
    ]
    const [hour, minute, second] = [
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
    ]

    if (
      !validDate(year, month, day) ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      throw invalid(`${field} is not a time that exists.`)
    }

    return {
      kind: "time",
      wall: { year, month, day, hour, minute, second },
      zone,
    }
  }

  const ms =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(
      text,
    )
      ? Date.parse(text)
      : Number.NaN

  if (Number.isNaN(ms)) {
    throw invalid(
      `${field}: give a date (2026-10-12) or a time (2026-10-12T09:00, read in the time zone; or with Z or an offset).`,
    )
  }

  return { kind: "time", wall: instantToWall(intlZone(zone), ms), zone }
}

/** A zone name an assistant passed, as Node spells it. */
export function checkZone(name: string): string {
  const zone = ianaZone(name)

  if (!zone) {
    throw invalid(
      `${name} is not a time zone PCP knows; use an IANA name like Europe/Amsterdam or America/New_York.`,
    )
  }

  return zone
}

export function inputInstant(value: TimeInput, dayZone: Zone): number {
  return value.kind === "date"
    ? wallToInstant(dayZone, { ...value.date, hour: 0, minute: 0, second: 0 })
    : value.zone === "UTC"
      ? Date.UTC(
          value.wall.year,
          value.wall.month - 1,
          value.wall.day,
          value.wall.hour,
          value.wall.minute,
          value.wall.second,
        )
      : wallToInstant(intlZone(value.zone), value.wall)
}

function icalTime(value: TimeInput): ICAL.Time {
  return value.kind === "date"
    ? ICAL.Time.fromData({ ...value.date, isDate: true })
    : value.zone === "UTC"
      ? ICAL.Time.fromData(value.wall, ICAL.Timezone.utcTimezone)
      : ICAL.Time.fromData(value.wall)
}

/** Adds a VTIMEZONE for an IANA zone the object does not define yet. */
export function ensureVtimezone(
  calendar: ICAL.Component,
  zone: string,
  year: number,
): void {
  if (zone === "UTC") {
    return
  }

  const has = calendar
    .getAllSubcomponents("vtimezone")
    .some((component) => component.getFirstPropertyValue("tzid") === zone)

  if (has) {
    return
  }

  const vtimezone = new ICAL.Component(
    ICAL.parse(
      `BEGIN:VCALENDAR\r\n${buildVtimezone(zone, year)}\r\nEND:VCALENDAR`,
    ) as unknown[],
  ).getFirstSubcomponent("vtimezone")

  if (vtimezone) {
    // Before the events, where clients look for it first.
    const events = [...calendar.getAllSubcomponents()]
    for (const event of events) calendar.removeSubcomponent(event)
    calendar.addSubcomponent(vtimezone)
    for (const event of events) calendar.addSubcomponent(event)
  }
}

/** Sets a time property, replacing the one there. */
export function setTime(
  calendar: ICAL.Component,
  component: ICAL.Component,
  name: string,
  value: TimeInput,
): void {
  component.removeAllProperties(name)
  const property = new ICAL.Property(name)

  if (value.kind === "time" && value.zone !== "UTC") {
    property.setParameter("tzid", value.zone)
    ensureVtimezone(calendar, value.zone, value.wall.year)
  }

  property.setValue(icalTime(value))
  component.addProperty(property)
}

function setText(
  component: ICAL.Component,
  name: string,
  value: string | null | undefined,
): void {
  if (value === undefined) {
    return
  }

  component.removeAllProperties(name)

  if (value !== null && value !== "") {
    component.addPropertyWithValue(name, value)
  }
}

function utcNow(): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(), true)
}

/** DTSTAMP and LAST-MODIFIED now, and SEQUENCE one up when the time moved. */
function touch(
  component: ICAL.Component,
  { timeChanged }: { timeChanged: boolean },
): void {
  component.updatePropertyWithValue("dtstamp", utcNow())
  component.updatePropertyWithValue("last-modified", utcNow())

  if (timeChanged) {
    const sequence = Number(component.getFirstPropertyValue("sequence") ?? 0)
    component.updatePropertyWithValue(
      "sequence",
      Number.isFinite(sequence) ? sequence + 1 : 1,
    )
  }
}

/** Alerts as DISPLAY alarms, minutes before the start; [] removes them. */
function setAlerts(
  component: ICAL.Component,
  minutes: number[] | undefined,
  description: string,
): void {
  if (minutes === undefined) {
    return
  }

  for (const alarm of [...component.getAllSubcomponents("valarm")]) {
    component.removeSubcomponent(alarm)
  }

  for (const before of [...new Set(minutes)].sort((a, b) => a - b)) {
    const alarm = new ICAL.Component("valarm")
    alarm.addPropertyWithValue("action", "DISPLAY")
    alarm.addPropertyWithValue("description", description || "Reminder")
    alarm.addPropertyWithValue(
      "trigger",
      ICAL.Duration.fromSeconds(-before * 60),
    )
    alarm.addPropertyWithValue("x-wr-alarmuid", randomUUID().toUpperCase())
    component.addSubcomponent(alarm)
  }
}

/** A recurrence rule as an assistant gives it. */
export type RecurrenceInput = {
  frequency: "daily" | "weekly" | "monthly" | "yearly"
  interval?: number
  count?: number
  /** The last day (or time) an occurrence may start. */
  until?: string
  /** MO…SU, or with a position in a month or year: 1MO, -1FR. */
  weekdays?: string[]
  monthDays?: number[]
  months?: number[]
}

/**
 * The RRULE for a recurrence, against the series' start: its UNTIL is a
 * date for an all-day series and a UTC time otherwise (RFC 5545 3.3.10),
 * the end of that day in the series' zone when given as a date.
 */
export function buildRule(
  input: RecurrenceInput,
  start: TimeInput,
  zone: string,
): ICAL.Recur {
  if (input.count !== undefined && input.until !== undefined) {
    throw invalid("recurrence: give count or until, not both.")
  }

  const data: Record<string, unknown> = {
    freq: input.frequency.toUpperCase(),
    ...(input.interval && input.interval > 1
      ? { interval: input.interval }
      : {}),
    ...(input.count !== undefined ? { count: input.count } : {}),
  }
  const parts: Record<string, unknown[]> = {}

  if (input.weekdays?.length) {
    parts.BYDAY = input.weekdays.map((day) => day.toUpperCase())
  }

  if (input.monthDays?.length) {
    parts.BYMONTHDAY = input.monthDays
  }

  if (input.months?.length) {
    parts.BYMONTH = input.months
  }

  if (input.until !== undefined) {
    const until = parseTimeInput(input.until, zone, "recurrence.until")

    if (start.kind === "date") {
      const date =
        until.kind === "date"
          ? until.date
          : {
              year: until.wall.year,
              month: until.wall.month,
              day: until.wall.day,
            }
      data.until = ICAL.Time.fromData({ ...date, isDate: true })
    } else {
      const lastMoment =
        until.kind === "date"
          ? inputInstant(
              {
                kind: "time",
                wall: { ...until.date, hour: 23, minute: 59, second: 59 },
                zone,
              },
              UTC_ZONE,
            )
          : inputInstant(until, UTC_ZONE)
      data.until = ICAL.Time.fromJSDate(new Date(lastMoment), true)
    }

    if (
      inputInstant(until, intlZone(zone)) < inputInstant(start, intlZone(zone))
    ) {
      throw invalid("recurrence.until is before the first occurrence.")
    }
  }

  const recur = ICAL.Recur.fromData(
    data as Parameters<typeof ICAL.Recur.fromData>[0],
  )

  for (const [name, values] of Object.entries(parts)) {
    recur.setComponent(name, values as string[])
  }

  return recur
}

function newCalendar(): ICAL.Component {
  const calendar = new ICAL.Component(["vcalendar", [], []])
  calendar.addPropertyWithValue("version", "2.0")
  calendar.addPropertyWithValue("prodid", PRODID)
  calendar.addPropertyWithValue("calscale", "GREGORIAN")
  return calendar
}

export function newUid(): string {
  return randomUUID().toUpperCase()
}

/** What an event is given when it is made, or changed (undefined: as it was). */
export type EventFields = {
  title?: string
  location?: string | null
  notes?: string | null
  url?: string | null
  alerts?: number[]
  availability?: "busy" | "free"
  recurrence?: RecurrenceInput | null
}

function applyFields(event: ICAL.Component, fields: EventFields): void {
  setText(event, "summary", fields.title)
  setText(event, "location", fields.location)
  setText(event, "description", fields.notes)
  setText(event, "url", fields.url)

  if (fields.availability !== undefined) {
    event.removeAllProperties("transp")
    event.addPropertyWithValue(
      "transp",
      fields.availability === "free" ? "TRANSPARENT" : "OPAQUE",
    )
  }
}

/** DTEND for an all-day event that ends (inclusive) on `last`. */
function allDayEnd(last: DateOnly): TimeInput {
  return { kind: "date", date: addDays(last, 1) }
}

/**
 * A new event's calendar object. `end` is inclusive for an all-day event
 * (the last day it covers), as an assistant says it.
 */
export function newEventObject(input: {
  uid: string
  start: TimeInput
  end: TimeInput
  zone: string
  fields: EventFields & { title: string }
}): string {
  const calendar = newCalendar()
  const event = new ICAL.Component("vevent")
  calendar.addSubcomponent(event)
  event.addPropertyWithValue("uid", input.uid)
  event.addPropertyWithValue("dtstamp", utcNow())
  event.addPropertyWithValue("created", utcNow())
  event.addPropertyWithValue("last-modified", utcNow())
  event.addPropertyWithValue("sequence", 0)
  setTime(calendar, event, "dtstart", input.start)
  setTime(
    calendar,
    event,
    "dtend",
    input.start.kind === "date" && input.end.kind === "date"
      ? allDayEnd(input.end.date)
      : input.end,
  )
  applyFields(event, input.fields)
  setAlerts(event, input.fields.alerts, input.fields.title)

  if (input.fields.recurrence) {
    event.addPropertyWithValue(
      "rrule",
      buildRule(input.fields.recurrence, input.start, input.zone),
    )
  }

  return calendar.toString()
}

export type EventChange = EventFields & {
  /** A new start; the end moves with it unless `end` is given too. */
  start?: TimeInput
  end?: TimeInput
}

function sameUid(a: ICAL.Component, b: ICAL.Component): boolean {
  return a.getFirstPropertyValue("uid") === b.getFirstPropertyValue("uid")
}

/** The VEVENT without RECURRENCE-ID: a series' master, or a lone event. */
export function masterEvent(calendar: ICAL.Component): ICAL.Component {
  const events = calendar.getAllSubcomponents("vevent")
  const master = events.find((event) => !event.hasProperty("recurrence-id"))

  if (!master) {
    throw new DavRequestError(
      "This event is an occurrence of someone else's series, which PCP does not change.",
    )
  }

  return master
}

/** A series' exception for one occurrence, if it has one. */
function exceptionFor(
  calendar: ICAL.Component,
  master: ICAL.Component,
  key: string,
  fallback: Zone,
): ICAL.Component | null {
  const resolve = zoneBook(calendar, fallback)

  return (
    calendar.getAllSubcomponents("vevent").find((event) => {
      if (!event.hasProperty("recurrence-id") || !sameUid(event, master)) {
        return false
      }

      const id = readTime(event, "recurrence-id", resolve, fallback)
      return id !== null && occurrenceKey(id, fallback) === key
    }) ?? null
  )
}

/** The start of the occurrence a key names, if the series has it. */
function occurrenceStart(
  calendar: ICAL.Component,
  master: ICAL.Component,
  key: string,
  fallback: Zone,
): TimeValue | null {
  const resolve = zoneBook(calendar, fallback)
  const start = readTime(master, "dtstart", resolve, fallback)

  if (!start) {
    return null
  }

  const keyMs =
    key.length === 10
      ? instantOf({ kind: "date", date: dateOfKey(key) }, fallback)
      : Date.parse(key)
  const { starts } = seriesStarts(master, start, keyMs + 1, resolve, fallback)

  return starts.find((value) => occurrenceKey(value, fallback) === key) ?? null
}

function dateOfKey(key: string): DateOnly {
  return {
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5, 7)),
    day: Number(key.slice(8, 10)),
  }
}

function asInput(value: TimeValue): TimeInput {
  return value.kind === "date"
    ? value
    : {
        kind: "time",
        wall: value.wall,
        zone: value.zone === UTC_ZONE ? "UTC" : value.zone.name,
      }
}

function setRecurrenceId(
  calendar: ICAL.Component,
  event: ICAL.Component,
  value: TimeValue,
): void {
  event.removeAllProperties("recurrence-id")
  const property = new ICAL.Property("recurrence-id")
  const input = asInput(value)

  if (input.kind === "time" && input.zone !== "UTC") {
    property.setParameter("tzid", input.zone)
    ensureVtimezone(calendar, input.zone, input.wall.year)
  }

  property.setValue(icalTime(input))
  event.addProperty(property)
}

/** Applies a start, end, or both to an event, keeping its length on a start alone. */
function moveTimes(
  calendar: ICAL.Component,
  event: ICAL.Component,
  change: EventChange,
  fallback: Zone,
): boolean {
  if (!change.start && !change.end) {
    return false
  }

  const resolve = zoneBook(calendar, fallback)
  const oldStart = readTime(event, "dtstart", resolve, fallback)
  const oldEnd = oldStart ? eventEnd(event, oldStart, resolve, fallback) : null
  const start = change.start ?? (oldStart ? asInput(oldStart) : null)

  if (!start) {
    throw new DavRequestError("This event has no start PCP can read.")
  }

  let end: TimeInput

  if (change.end) {
    end =
      start.kind === "date" && change.end.kind === "date"
        ? allDayEnd(change.end.date)
        : change.end
  } else if (start.kind === "date") {
    // The days it covered, from the new start; one when it was timed.
    const days =
      oldStart?.kind === "date" && oldEnd?.kind === "date"
        ? Math.round(
            (instantOf(oldEnd, UTC_ZONE) - instantOf(oldStart, UTC_ZONE)) /
              86_400_000,
          )
        : 1
    end = { kind: "date", date: addDays(start.date, Math.max(1, days)) }
  } else {
    // The length it had, from the new start; an hour when it was all-day.
    const length =
      oldStart?.kind === "time" && oldEnd
        ? instantOf(oldEnd, fallback) - instantOf(oldStart, fallback)
        : 3_600_000
    end = {
      kind: "time",
      wall: instantToWall(
        intlZoneOrUtc(start.zone),
        inputInstant(start, fallback) + length,
      ),
      zone: start.zone,
    }
  }

  if (start.kind !== end.kind) {
    throw invalid(
      "start and end are both dates (an all-day event) or both times.",
    )
  }

  if (inputInstant(end, fallback) <= inputInstant(start, fallback)) {
    throw invalid("The event would end before it starts.")
  }

  setTime(calendar, event, "dtstart", start)
  event.removeAllProperties("duration")
  setTime(calendar, event, "dtend", end)

  // A series' rule stays with its start: an all-day series' UNTIL is a date.
  return true
}

/**
 * Changes an event in its calendar object. With `occurrence` and scope
 * "this", only that occurrence of a series changes: its exception is made or
 * changed. Otherwise the whole event (the series) does; a new start given
 * for one occurrence moves every occurrence by as much.
 */
export function changeEvent(
  data: string,
  change: EventChange,
  {
    occurrence,
    scope,
    fallback,
    zone,
  }: {
    occurrence: string | null
    scope: "this" | "all"
    fallback: Zone
    zone: string
  },
): string {
  const calendar = parseCalendarObject(data)
  const master = masterEvent(calendar)
  const recurring = isRecurring(master)

  if (occurrence && !recurring) {
    throw invalid("This event does not repeat; leave occurrence out.")
  }

  if (occurrence && scope === "this") {
    if (change.recurrence !== undefined) {
      throw invalid(
        'An occurrence has no recurrence of its own: change the series with scope "all".',
      )
    }

    let exception = exceptionFor(calendar, master, occurrence, fallback)

    if (!exception) {
      const original = occurrenceStart(calendar, master, occurrence, fallback)

      if (!original) {
        throw new DavRequestError(
          "The event has no occurrence at that time; list_events gives each occurrence's id.",
        )
      }

      exception = ICAL.Component.fromString(master.toString())

      for (const name of ["rrule", "rdate", "exdate"]) {
        exception.removeAllProperties(name)
      }

      const resolve = zoneBook(calendar, fallback)
      const start = readTime(master, "dtstart", resolve, fallback)!
      const end = eventEnd(master, start, resolve, fallback)
      const length = instantOf(end, fallback) - instantOf(start, fallback)
      setTime(calendar, exception, "dtstart", asInput(original))
      exception.removeAllProperties("duration")
      setTime(
        calendar,
        exception,
        "dtend",
        original.kind === "date" && start.kind === "date" && end.kind === "date"
          ? {
              kind: "date",
              date: addDays(
                original.date,
                Math.round(length / 86_400_000) || 1,
              ),
            }
          : asInput({
              ...(original as Extract<TimeValue, { kind: "time" }>),
              wall: instantToWall(
                (original as Extract<TimeValue, { kind: "time" }>).zone,
                instantOf(original, fallback) + length,
              ),
            }),
      )
      setRecurrenceId(calendar, exception, original)
      calendar.addSubcomponent(exception)
    }

    const moved = moveTimes(calendar, exception, change, fallback)
    applyFields(exception, change)
    setAlerts(exception, change.alerts, change.title ?? "")
    touch(exception, { timeChanged: moved })
    return calendar.toString()
  }

  let timeChange = change

  // One occurrence's new start, said for the whole series: every
  // occurrence moves by as much.
  if (occurrence && change.start) {
    const original = occurrenceStart(calendar, master, occurrence, fallback)
    const resolve = zoneBook(calendar, fallback)
    const start = readTime(master, "dtstart", resolve, fallback)

    if (!original || !start) {
      throw new DavRequestError(
        "The event has no occurrence at that time; list_events gives each occurrence's id.",
      )
    }

    if (original.kind !== change.start.kind) {
      throw invalid(
        "To make a series all-day (or timed), change it without an occurrence and give the series' first start.",
      )
    }

    const delta =
      inputInstant(change.start, fallback) - instantOf(original, fallback)
    const moved = asInput(start)
    timeChange = {
      ...change,
      start:
        moved.kind === "date"
          ? {
              kind: "date",
              date: addDays(moved.date, Math.round(delta / 86_400_000)),
            }
          : {
              kind: "time",
              wall: instantToWall(
                change.start.kind === "time"
                  ? intlZoneOrUtc(change.start.zone)
                  : fallback,
                instantOf(start, fallback) + delta,
              ),
              zone:
                change.start.kind === "time" ? change.start.zone : moved.zone,
            },
      end: undefined,
    }
  }

  const moved = moveTimes(calendar, master, timeChange, fallback)
  applyFields(master, change)
  setAlerts(master, change.alerts, change.title ?? "")

  if (change.recurrence !== undefined) {
    master.removeAllProperties("rrule")

    if (change.recurrence) {
      const resolve = zoneBook(calendar, fallback)
      const start = readTime(master, "dtstart", resolve, fallback)!
      master.addPropertyWithValue(
        "rrule",
        buildRule(change.recurrence, asInput(start), zone),
      )
    } else {
      // No longer a series: its exceptions and exclusions go with it.
      master.removeAllProperties("rdate")
      master.removeAllProperties("exdate")

      for (const event of [...calendar.getAllSubcomponents("vevent")]) {
        if (event !== master && event.hasProperty("recurrence-id")) {
          calendar.removeSubcomponent(event)
        }
      }
    }
  }

  touch(master, { timeChanged: moved || change.recurrence !== undefined })
  return calendar.toString()
}

function intlZoneOrUtc(name: string): Zone {
  return name === "UTC" ? UTC_ZONE : intlZone(name)
}

/**
 * Removes one occurrence of a series: an EXDATE for it, and its exception
 * if it had one. Null when it was the series' only occurrence left, so the
 * caller deletes the whole object instead.
 */
export function removeOccurrence(
  data: string,
  occurrence: string,
  fallback: Zone,
): string {
  const calendar = parseCalendarObject(data)
  const master = masterEvent(calendar)

  if (!isRecurring(master)) {
    throw invalid("This event does not repeat; leave occurrence out.")
  }

  const original = occurrenceStart(calendar, master, occurrence, fallback)
  const exception = exceptionFor(calendar, master, occurrence, fallback)

  if (!original && !exception) {
    throw new DavRequestError(
      "The event has no occurrence at that time; list_events gives each occurrence's id.",
    )
  }

  if (exception) {
    calendar.removeSubcomponent(exception)
  }

  if (original) {
    const input = asInput(original)
    const property = new ICAL.Property("exdate")

    if (input.kind === "time" && input.zone !== "UTC") {
      property.setParameter("tzid", input.zone)
    }

    property.setValue(icalTime(input))
    master.addProperty(property)
  }

  touch(master, { timeChanged: true })
  return calendar.toString()
}

export function parseCalendarObject(data: string): ICAL.Component {
  try {
    return new ICAL.Component(ICAL.parse(data) as unknown[])
  } catch {
    throw new DavRequestError(
      "The calendar server holds something here that is not iCalendar.",
    )
  }
}

// ---------------------------------------------------------------------------
// Reminders

export type ReminderFields = {
  title?: string
  notes?: string | null
  url?: string | null
  /** null clears it. */
  due?: TimeInput | null
  priority?: "high" | "medium" | "low" | "none"
  /** An alert at the due time. */
  alert?: boolean
  recurrence?: RecurrenceInput | null
}

const PRIORITY = { high: 1, medium: 5, low: 9, none: 0 } as const

function applyReminderFields(
  calendar: ICAL.Component,
  todo: ICAL.Component,
  fields: ReminderFields,
  zone: string,
  fallback: Zone,
): void {
  setText(todo, "summary", fields.title)
  setText(todo, "description", fields.notes)
  setText(todo, "url", fields.url)

  if (fields.priority !== undefined) {
    todo.removeAllProperties("priority")

    if (fields.priority !== "none") {
      todo.addPropertyWithValue("priority", PRIORITY[fields.priority])
    }
  }

  if (fields.due !== undefined) {
    if (fields.due === null) {
      todo.removeAllProperties("due")
      todo.removeAllProperties("dtstart")
      todo.removeAllProperties("rrule")
    } else {
      setTime(calendar, todo, "due", fields.due)
      // Apple's Reminders and RFC 5545's recurrence both start from DTSTART:
      // it is the due time.
      setTime(calendar, todo, "dtstart", fields.due)
    }
  }

  if (fields.recurrence !== undefined) {
    todo.removeAllProperties("rrule")

    if (fields.recurrence) {
      const resolve = zoneBook(calendar, fallback)
      const due = readTime(todo, "due", resolve, fallback)

      if (!due) {
        throw invalid("A repeating reminder needs a due date.")
      }

      todo.addPropertyWithValue(
        "rrule",
        buildRule(fields.recurrence, asInput(due), zone),
      )
    }
  }

  const resolve = zoneBook(calendar, fallback)
  const due = readTime(todo, "due", resolve, fallback)
  const wantsAlert =
    fields.alert ??
    (fields.due !== undefined
      ? todo.getAllSubcomponents("valarm").length > 0
      : undefined)

  if (wantsAlert !== undefined) {
    for (const alarm of [...todo.getAllSubcomponents("valarm")]) {
      todo.removeSubcomponent(alarm)
    }

    if (wantsAlert && due) {
      const alarm = new ICAL.Component("valarm")
      alarm.addPropertyWithValue("action", "DISPLAY")
      alarm.addPropertyWithValue("description", fields.title ?? "Reminder")
      const trigger = new ICAL.Property("trigger")
      trigger.resetType("date-time")
      trigger.setValue(
        ICAL.Time.fromJSDate(new Date(instantOf(due, fallback)), true),
      )
      alarm.addProperty(trigger)
      alarm.addPropertyWithValue("x-wr-alarmuid", randomUUID().toUpperCase())
      todo.addSubcomponent(alarm)
    } else if (wantsAlert && fields.alert) {
      throw invalid(
        "An alert goes off at the due time: give the reminder a due date.",
      )
    }
  }
}

export function newReminderObject(input: {
  uid: string
  zone: string
  fallback: Zone
  fields: ReminderFields & { title: string }
}): string {
  const calendar = newCalendar()
  const todo = new ICAL.Component("vtodo")
  calendar.addSubcomponent(todo)
  todo.addPropertyWithValue("uid", input.uid)
  todo.addPropertyWithValue("dtstamp", utcNow())
  todo.addPropertyWithValue("created", utcNow())
  todo.addPropertyWithValue("last-modified", utcNow())
  todo.addPropertyWithValue("status", "NEEDS-ACTION")
  applyReminderFields(calendar, todo, input.fields, input.zone, input.fallback)
  return calendar.toString()
}

function todoOf(calendar: ICAL.Component): ICAL.Component {
  const todos = calendar.getAllSubcomponents("vtodo")
  const todo =
    todos.find((candidate) => !candidate.hasProperty("recurrence-id")) ??
    todos[0]

  if (!todo) {
    throw new DavRequestError("That is not a reminder.")
  }

  return todo
}

export function changeReminder(
  data: string,
  fields: ReminderFields,
  { zone, fallback }: { zone: string; fallback: Zone },
): string {
  const calendar = parseCalendarObject(data)
  const todo = todoOf(calendar)
  applyReminderFields(calendar, todo, fields, zone, fallback)
  touch(todo, { timeChanged: fields.due !== undefined })
  return calendar.toString()
}

/**
 * Marks a reminder done, or not done. A repeating one that is marked done
 * moves on to its next due date and stays open, as Reminders does; the
 * answer says where to (`next`), or that its series is over.
 */
export function completeReminder(
  data: string,
  completed: boolean,
  fallback: Zone,
): { data: string; next: TimeValue | null } {
  const calendar = parseCalendarObject(data)
  const todo = todoOf(calendar)
  const resolve = zoneBook(calendar, fallback)
  let next: TimeValue | null = null

  if (completed && isRecurring(todo)) {
    const due = readTime(todo, "due", resolve, fallback)
    const start = readTime(todo, "dtstart", resolve, fallback) ?? due

    if (due && start && start.kind === due.kind) {
      const dueMs = instantOf(due, fallback)
      const startMs = instantOf(start, fallback)
      const { starts } = seriesStarts(
        todo,
        start,
        Math.max(dueMs, Date.now()) + 2 * 366 * 86_400_000,
        resolve,
        fallback,
      )
      // The first occurrence after the one now due.
      const after = starts.find((value) => instantOf(value, fallback) > startMs)

      if (after) {
        const shift = instantOf(after, fallback) - startMs
        const move = (value: TimeValue): TimeInput =>
          value.kind === "date"
            ? {
                kind: "date",
                date: addDays(value.date, Math.round(shift / 86_400_000)),
              }
            : asInput({
                ...value,
                wall: instantToWall(
                  value.zone,
                  instantOf(value, fallback) + shift,
                ),
              })

        setTime(calendar, todo, "dtstart", move(start))
        const newDue = move(due)
        setTime(calendar, todo, "due", newDue)
        next = readTime(todo, "due", resolve, fallback)
        todo.removeAllProperties("completed")
        todo.removeAllProperties("percent-complete")
        todo.updatePropertyWithValue("status", "NEEDS-ACTION")

        // The alert moves with it.
        for (const alarm of [...todo.getAllSubcomponents("valarm")]) {
          const trigger = alarm.getFirstProperty("trigger")
          const value = trigger?.getFirstValue()

          if (trigger && value instanceof ICAL.Time && next) {
            trigger.setValue(
              ICAL.Time.fromJSDate(new Date(instantOf(next, fallback)), true),
            )
          }
        }

        touch(todo, { timeChanged: true })
        return { data: calendar.toString(), next }
      }
    }
  }

  if (completed) {
    todo.updatePropertyWithValue("status", "COMPLETED")
    todo.updatePropertyWithValue("completed", utcNow())
    todo.updatePropertyWithValue("percent-complete", 100)
  } else {
    todo.updatePropertyWithValue("status", "NEEDS-ACTION")
    todo.removeAllProperties("completed")
    todo.removeAllProperties("percent-complete")
  }

  touch(todo, { timeChanged: false })
  return { data: calendar.toString(), next }
}
