import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import { invalid } from "../errors"
import {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_RANGE_DAYS,
  DEFAULT_REMINDER_LIMIT,
  MAX_ALERT_MINUTES,
  MAX_ALERTS,
  MAX_BULK_REMINDERS,
  MAX_CALENDAR_NAME_CHARS,
  MAX_EVENT_LIMIT,
  MAX_FREE_SLOTS,
  MAX_LOCATION_CHARS,
  MAX_NOTES_CHARS,
  MAX_RANGE_DAYS,
  MAX_REMINDER_LIMIT,
  MAX_SEARCH_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from "./limits"

/**
 * The tools a calendar account offers: calendars and events, reminders
 * (to-dos), and finding free time, shaped around what an assistant is asked
 * to do ("what is on Tuesday", "find an hour with nobody booked", "move the
 * dentist to Friday", "remind me to call Ada") rather than around WebDAV.
 * Times go in and come out as ISO 8601 with their offset; recurring events
 * come out one occurrence at a time. Arguments are checked here, before
 * anything connects.
 *
 * A fixed set on purpose, not the protocol passed through: no tool takes a
 * WebDAV method or raw iCalendar, and none invites people (adding attendees
 * would have the server email them).
 */

export type CalendarToolName =
  | "list_calendars"
  | "list_events"
  | "get_event"
  | "find_free_time"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "list_reminders"
  | "create_reminder"
  | "update_reminder"
  | "complete_reminder"
  | "delete_reminder"
  | "create_calendar"

type Annotations = {
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint: boolean
}

export type CalendarToolSpec = {
  name: CalendarToolName
  title: string
  description: string
  args: z.ZodType
  annotations: Annotations
  /** Changes a calendar: absent on a read-only account, and refused there. */
  writes: boolean
}

const OBJECT_ID = /^[^/\s?#]+\/[^/\s?#]+$/

const eventId = z
  .string()
  .min(3)
  .max(1000)
  .regex(OBJECT_ID, {
    message: "An id as list_events gives it: calendar/event.",
  })
  .refine(
    (value) => !value.split("/").some((part) => part === "." || part === ".."),
    {
      message: "An id as list_events gives it.",
    },
  )
  .describe("The event's id, from list_events.")
const reminderId = eventId.describe("The reminder's id, from list_reminders.")
const occurrence = z
  .string()
  .min(10)
  .max(40)
  .describe(
    "For a repeating event: which occurrence, as list_events gives it in occurrence.",
  )
const calendar = z
  .string()
  .min(1)
  .max(500)
  .describe("A calendar: its id or its name, from list_calendars.")
const reminderList = z
  .string()
  .min(1)
  .max(500)
  .describe("A reminder list: its id or its name, from list_calendars.")
const timeText = z.string().min(10).max(40)
const timezone = z
  .string()
  .min(1)
  .max(100)
  .describe(
    "An IANA time zone (Europe/Amsterdam) that times without an offset are read in, and answers are given in. Default: the calendar's own, else PCP's.",
  )
const title = z
  .string()
  .min(1)
  .max(MAX_TITLE_CHARS)
  .regex(/^[^\u0000-\u001f\u007f]+$/, { message: "A title on one line." })
const notes = z.string().max(MAX_NOTES_CHARS)
const url = z
  .string()
  .max(MAX_URL_CHARS)
  .regex(/^(https?|mailto|tel):[^\s]*$/i, {
    message: "An http(s), mailto or tel address.",
  })
const alerts = z
  .array(z.number().int().min(0).max(MAX_ALERT_MINUTES))
  .max(MAX_ALERTS)
  .describe(
    "Alerts, as minutes before the start: [15] alerts a quarter of an hour before, [0] at the start. [] removes them.",
  )
const WEEKDAY = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/i
const recurrence = z
  .strictObject({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Every how many days, weeks… (default 1)."),
    count: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("How many times in all."),
    until: timeText
      .optional()
      .describe(
        "The last date it may happen on (2026-12-31); leave out count and until for no end.",
      ),
    weekdays: z
      .array(
        z.string().regex(WEEKDAY, {
          message:
            "MO, TU, WE, TH, FR, SA or SU, with a position for monthly (1MO: the first Monday, -1FR: the last Friday).",
        }),
      )
      .min(1)
      .max(7)
      .optional()
      .describe(
        'Weekly: the days, ["MO","WE"]. Monthly or yearly: a day by position, ["1MO"] (first Monday) or ["-1FR"] (last Friday).',
      ),
    monthDays: z
      .array(
        z
          .number()
          .int()
          .min(-31)
          .max(31)
          .refine((day) => day !== 0),
      )
      .min(1)
      .max(31)
      .optional()
      .describe("Monthly: the days of the month, [1, 15]; -1 is the last."),
    months: z
      .array(z.number().int().min(1).max(12))
      .min(1)
      .max(12)
      .optional()
      .describe("Yearly: the months, 1 to 12."),
  })
  .describe("How it repeats.")
const noArgs = () => z.strictObject({})

const READS: Annotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
}

const WRITES: Annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}

const SPECS: readonly CalendarToolSpec[] = [
  {
    name: "list_calendars",
    title: "List calendars and reminder lists",
    description:
      "Lists this account's calendars and reminder lists: each one's id, name, what it holds (events, reminders or both), its color and time zone, and whether you can write to it. The first writable one of each kind is where new events and reminders go when you name none.",
    args: noArgs(),
    annotations: READS,
    writes: false,
  },
  {
    name: "list_events",
    title: "List events",
    description: `Lists the events between two times in every calendar (or one), soonest first, with each occurrence of a repeating event on its own. Answers with each event's id (and occurrence, for a repeating one), title, start, end, whether it is all-day, location, the start of its notes, its calendar and how it repeats. With no times it lists the next ${DEFAULT_RANGE_DAYS} days from the start of today. Up to ${MAX_RANGE_DAYS} days at once. text narrows it to events whose title, location or notes contain those words.`,
    args: z.strictObject({
      from: timeText
        .optional()
        .describe(
          "Where to start: a date (2026-10-12, from its start) or a time. Default: the start of today.",
        ),
      to: timeText
        .optional()
        .describe(
          `Where to stop: a date (up to and including that day) or a time. Default: ${DEFAULT_RANGE_DAYS} days after from.`,
        ),
      calendar: calendar
        .optional()
        .describe(
          "Only this calendar (id or name). Default: every calendar with events.",
        ),
      text: z
        .string()
        .min(1)
        .max(MAX_SEARCH_TEXT_CHARS)
        .optional()
        .describe(
          "Only events whose title, location or notes contain this (any case).",
        ),
      timezone: timezone.optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_EVENT_LIMIT)
        .optional()
        .describe(`How many at most (default ${DEFAULT_EVENT_LIMIT}).`),
    }),
    annotations: READS,
    writes: false,
  },
  {
    name: "get_event",
    title: "Read an event",
    description:
      "Reads one event in full: its times, location, all of its notes, link, how it repeats, its alerts, organizer and attendees with their answers, and its availability (busy or free). For one occurrence of a repeating event, pass occurrence.",
    args: z.strictObject({
      id: eventId,
      occurrence: occurrence.optional(),
      timezone: timezone.optional(),
    }),
    annotations: READS,
    writes: false,
  },
  {
    name: "find_free_time",
    title: "Find free time",
    description: `Finds the free stretches of at least duration_minutes between two times, within working hours (day_start to day_end on the given weekdays), counting every event marked busy in the calendars looked at. All-day events do not count unless include_all_day is true. Answers with up to ${MAX_FREE_SLOTS} free stretches, each with its start, end and length, soonest first.`,
    args: z.strictObject({
      from: timeText.describe("Where to start looking: a date or a time."),
      to: timeText.describe(
        "Where to stop: a date (up to and including that day) or a time.",
      ),
      duration_minutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60)
        .optional()
        .describe("How long a stretch must be at least (default 30)."),
      day_start: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
          message: "A time of day, like 09:00.",
        })
        .optional()
        .describe("When a day's free time may start (default 09:00)."),
      day_end: z
        .string()
        .regex(/^([01]\d|2[0-4]):[0-5]\d$/, {
          message: "A time of day, like 17:00.",
        })
        .optional()
        .describe("When it must end (default 17:00; 24:00 for midnight)."),
      weekdays: z
        .array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
        .min(1)
        .max(7)
        .optional()
        .describe('The days to look on (default ["MO","TU","WE","TH","FR"]).'),
      calendars: z
        .array(calendar)
        .min(1)
        .max(50)
        .optional()
        .describe(
          "The calendars whose events count (ids or names). Default: every calendar with events.",
        ),
      include_all_day: z
        .boolean()
        .optional()
        .describe("Count all-day events marked busy too (default false)."),
      timezone: timezone.optional(),
    }),
    annotations: READS,
    writes: false,
  },
  {
    name: "create_event",
    title: "Create an event",
    description:
      "Adds an event to a calendar (the first writable one when you name none). A start that is a date (2026-10-12) makes an all-day event, ending on end's date (the same day by default); a time (2026-10-12T09:00) makes a timed one, ending at end or after duration_minutes (an hour by default). Times without an offset are in timezone. Add alerts, a location, notes, a link, and recurrence for a repeating event. It invites nobody. Answers with the event as get_event gives it, with its id.",
    args: z.strictObject({
      calendar: calendar.optional(),
      title,
      start: timeText.describe("A date (all-day) or a time."),
      end: timeText
        .optional()
        .describe(
          "A date (the last day of an all-day event) or a time; leave out to use duration_minutes.",
        ),
      duration_minutes: z
        .number()
        .int()
        .min(1)
        .max(60 * 24 * 31)
        .optional()
        .describe("For a timed event without end: how long (default 60)."),
      timezone: timezone.optional(),
      location: z.string().max(MAX_LOCATION_CHARS).optional(),
      notes: notes.optional(),
      url: url.optional(),
      alerts: alerts.optional(),
      availability: z
        .enum(["busy", "free"])
        .optional()
        .describe("Whether it counts as busy (default) or free in free time."),
      recurrence: recurrence.optional(),
    }),
    annotations: WRITES,
    writes: true,
  },
  {
    name: "update_event",
    title: "Change or move an event",
    description:
      'Changes an event: what you pass changes, what you leave out stays, and null clears location, notes or url. A new start alone keeps its length. For a repeating event, pass occurrence to change just that one (scope "this", the default with occurrence), or scope "all" to change the whole series: a new start for one occurrence with scope "all" moves every occurrence by as much. recurrence null makes it stop repeating. calendar moves the whole event to another calendar. Answers with the event as it is now.',
    args: z
      .strictObject({
        id: eventId,
        occurrence: occurrence.optional(),
        scope: z
          .enum(["this", "all"])
          .optional()
          .describe(
            'With occurrence: "this" (default) changes that occurrence, "all" the whole series.',
          ),
        calendar: calendar
          .optional()
          .describe("Move the event to this calendar."),
        title: title.optional(),
        start: timeText.optional(),
        end: timeText.optional(),
        timezone: timezone.optional(),
        location: z.string().max(MAX_LOCATION_CHARS).nullable().optional(),
        notes: notes.nullable().optional(),
        url: url.nullable().optional(),
        alerts: alerts.optional(),
        availability: z.enum(["busy", "free"]).optional(),
        recurrence: recurrence.nullable().optional(),
      })
      .refine(
        (value) =>
          [
            "calendar",
            "title",
            "start",
            "end",
            "location",
            "notes",
            "url",
            "alerts",
            "availability",
            "recurrence",
          ].some(
            (key) => (value as Record<string, unknown>)[key] !== undefined,
          ),
        { message: "Say what to change." },
      )
      .refine(
        (value) =>
          !(value.calendar && value.occurrence && value.scope !== "all"),
        {
          message:
            "A whole event moves to another calendar: leave occurrence out.",
        },
      ),
    annotations: { ...WRITES, idempotentHint: true },
    writes: true,
  },
  {
    name: "delete_event",
    title: "Delete an event",
    description:
      "Deletes an event from its calendar; for one occurrence of a repeating event, pass occurrence and only that one goes (the rest of the series stays). Calendars keep no trash: this cannot be undone, though the answer gives what was deleted.",
    args: z.strictObject({ id: eventId, occurrence: occurrence.optional() }),
    annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
    writes: true,
  },
  {
    name: "list_reminders",
    title: "List reminders",
    description: `Lists reminders (to-dos) in every reminder list (or one): by default the open ones, soonest due first and those with no due date last. Answers with each one's id, title, due date or time, priority, whether it is done, its notes, list and whether it repeats. due_before narrows it to what is due by then (overdue included); text to titles and notes containing those words.`,
    args: z.strictObject({
      list: reminderList
        .optional()
        .describe("Only this reminder list (id or name). Default: every list."),
      status: z
        .enum(["open", "completed", "all"])
        .optional()
        .describe("open (default), completed, or all."),
      due_before: timeText
        .optional()
        .describe(
          "Only reminders due by then: a date (up to and including that day) or a time.",
        ),
      text: z.string().min(1).max(MAX_SEARCH_TEXT_CHARS).optional(),
      timezone: timezone.optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_REMINDER_LIMIT)
        .optional()
        .describe(`How many at most (default ${DEFAULT_REMINDER_LIMIT}).`),
    }),
    annotations: READS,
    writes: false,
  },
  {
    name: "create_reminder",
    title: "Create a reminder",
    description:
      "Adds a reminder (a to-do) to a list (the first writable one when you name none). due is a date (2026-10-12) or a time (2026-10-12T17:00); alert true makes it alert at that time. priority is high, medium or low. A repeating reminder (recurrence) needs a due date. Answers with the reminder and its id.",
    args: z.strictObject({
      list: reminderList.optional(),
      title,
      notes: notes.optional(),
      due: timeText.optional().describe("When it is due: a date or a time."),
      timezone: timezone.optional(),
      priority: z.enum(["high", "medium", "low", "none"]).optional(),
      alert: z
        .boolean()
        .optional()
        .describe("Alert at the due time (needs a due time)."),
      url: url.optional(),
      recurrence: recurrence.optional(),
    }),
    annotations: WRITES,
    writes: true,
  },
  {
    name: "update_reminder",
    title: "Change a reminder",
    description:
      "Changes a reminder: what you pass changes, what you leave out stays; null clears notes, url, due or recurrence. completed marks it done or open again (complete_reminder does the same for several). list moves it to another list. Answers with the reminder as it is now.",
    args: z
      .strictObject({
        id: reminderId,
        list: reminderList.optional().describe("Move it to this list."),
        title: title.optional(),
        notes: notes.nullable().optional(),
        due: timeText.nullable().optional(),
        timezone: timezone.optional(),
        priority: z.enum(["high", "medium", "low", "none"]).optional(),
        alert: z.boolean().optional(),
        url: url.nullable().optional(),
        recurrence: recurrence.nullable().optional(),
        completed: z.boolean().optional(),
      })
      .refine(
        (value) =>
          [
            "list",
            "title",
            "notes",
            "due",
            "priority",
            "alert",
            "url",
            "recurrence",
            "completed",
          ].some(
            (key) => (value as Record<string, unknown>)[key] !== undefined,
          ),
        { message: "Say what to change." },
      ),
    annotations: { ...WRITES, idempotentHint: true },
    writes: true,
  },
  {
    name: "complete_reminder",
    title: "Complete reminders",
    description: `Marks a reminder done, or up to ${MAX_BULK_REMINDERS} with ids (completed false opens them again). A repeating reminder moves on to its next due date and stays open, as in Reminders. With ids, the answer lists the ones changed (done) and the ones that could not be, with why (failed).`,
    args: z
      .strictObject({
        id: reminderId.optional(),
        ids: z.array(reminderId).min(1).max(MAX_BULK_REMINDERS).optional(),
        completed: z
          .boolean()
          .optional()
          .describe("true (default) marks done; false opens again."),
      })
      .refine(
        (value) => (value.id === undefined) !== (value.ids === undefined),
        {
          message: "Give id for one reminder, or ids for several.",
        },
      ),
    annotations: { ...WRITES, idempotentHint: true },
    writes: true,
  },
  {
    name: "delete_reminder",
    title: "Delete a reminder",
    description:
      "Deletes a reminder for good (there is no trash); completing it with complete_reminder keeps it. Answers with what was deleted.",
    args: z.strictObject({ id: reminderId }),
    annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
    writes: true,
  },
  {
    name: "create_calendar",
    title: "Create a calendar or reminder list",
    description:
      "Makes a new calendar (holds events) or reminder list (holds reminders) in this account, with a name and an optional color. Answers with it as list_calendars gives it.",
    args: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(MAX_CALENDAR_NAME_CHARS)
        .regex(/^[^\u0000-\u001f\u007f]+$/, { message: "A name on one line." }),
      holds: z
        .enum(["events", "reminders"])
        .describe("events for a calendar, reminders for a reminder list."),
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, { message: "A color like #FF9500." })
        .optional(),
    }),
    annotations: WRITES,
    writes: true,
  },
]

const BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]))

export function calendarToolSpec(name: string): CalendarToolSpec | undefined {
  return BY_NAME.get(name as CalendarToolName)
}

function jsonSchema(schema: z.ZodType): unknown {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>
  delete generated.$schema
  return generated
}

/** The tools an account has, for the catalogue. */
export function calendarTools({
  readOnly,
}: {
  readOnly: boolean
}): CatalogueTool[] {
  return SPECS.filter((spec) => !(readOnly && spec.writes)).map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: jsonSchema(spec.args),
    annotations: spec.annotations,
  }))
}

/** A tool's arguments, checked; a readable refusal otherwise. */
export function parseCalendarArgs(
  spec: CalendarToolSpec,
  args: unknown,
): Record<string, unknown> {
  const parsed = spec.args.safeParse(args ?? {})

  if (!parsed.success) {
    throw invalid(
      `${spec.name}: ${z
        .prettifyError(parsed.error)
        .replace(/\s*\n\s*/g, " ")
        .slice(0, 500)}`,
    )
  }

  return parsed.data as Record<string, unknown>
}
