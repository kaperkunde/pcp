import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, isPcpError, PcpError } from "../errors"
import { newId } from "../ids"
import { errorToolResult, jsonToolResult } from "../json-result"
import { makeRedactor } from "../openapi/redact"
import {
  getServer,
  kindNoun,
  normalizeBasicAuth,
  normalizeHeaderAuth,
  normalizeNameAndDescription,
  normalizeOAuthClient,
  oauthTokensObsolete,
  secretColumns,
  setServerStatus,
  slugify,
  uniqueSlug,
  withNewSecret,
  type NewSecret,
  type OAuthClientInput,
} from "../servers"
import { deleteManagedSecret } from "../secrets"
import { requireEncryptedOrPrivate, validateCalDavUrl } from "./addresses"
import { DavClient, lastSegment } from "./client"
import {
  changeEvent,
  changeReminder,
  checkZone,
  completeReminder,
  inputInstant,
  newEventObject,
  newReminderObject,
  newUid,
  parseCalendarObject,
  parseTimeInput,
  removeOccurrence,
  type EventChange,
  type RecurrenceInput,
  type ReminderFields,
  type TimeInput,
} from "./compose"
import {
  alertsOf,
  eventDetails,
  expandEvents,
  formatTime,
  instantOf,
  occurrenceOf,
  parseOccurrenceKey,
  readReminder,
  ruleOf,
  zoneBook,
  type Occurrence,
  type ReminderView,
  type TimeValue,
} from "./ical"
import {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_RANGE_DAYS,
  DEFAULT_REMINDER_LIMIT,
  MAX_FREE_SLOTS,
  MAX_LISTED_NOTES_CHARS,
  MAX_RANGE_DAYS,
} from "./limits"
import { calendarToolSpec, calendarTools, parseCalendarArgs } from "./tools"
import {
  DavAuthError,
  DavRequestError,
  type CalendarInfo,
  type DavCredential,
  type DavObject,
} from "./types"
import {
  addDays,
  formatInZone,
  instantToWall,
  intlZone,
  machineZone,
  wallToInstant,
  type Zone,
} from "./zones"

/**
 * Calendar accounts: servers of kind "caldav". The owner adds one in PCP
 * with the CalDAV server's address and how to sign in (for iCloud, the
 * Apple ID and an app-specific password), or agrees to one an assistant
 * proposed through register_server; PCP then offers the fixed calendar
 * tools (tools.ts) through the gateway like any server's.
 *
 * Secrets never come here: upstream.ts hands in a DavCredential with the
 * header already made. Assistants never change the account itself; only the
 * owner can, in PCP.
 */

export type CalendarAccountInput = OAuthClientInput & {
  name: string
  description?: string
  /** The CalDAV server, or a calendar home on it. */
  url: string
  readOnly: boolean
  /** basic (a login and an app password), header (a bearer token) or oauth. */
  authType: "basic" | "header" | "oauth"
  authUsername?: string | null
  authSecretId?: string | null
  authSecretName?: string | null
  authSecretValue?: string | null
}

const EMPTY_AUTH = {
  authUsername: null as string | null,
  authSecretId: null as string | null,
  authHeaderName: null as string | null,
  authValueTemplate: null as string | null,
  oauthClientId: null as string | null,
  oauthClientSecretId: null as string | null,
  oauthScope: null as string | null,
  oauthAuthorizeParams: null as string | null,
}

async function normalizeCalendarAccount(
  ctx: VaultContext,
  input: CalendarAccountInput,
) {
  const { name, description } = normalizeNameAndDescription(input)
  const url = validateCalDavUrl(input.url)
  await requireEncryptedOrPrivate(url)
  const auth = { ...EMPTY_AUTH }
  let newSecret: NewSecret | null = null

  switch (input.authType) {
    case "basic": {
      const basic = await normalizeBasicAuth(ctx, input, { name })
      auth.authUsername = basic.authUsername
      auth.authSecretId = basic.authSecretId
      newSecret = basic.newSecret
      break
    }
    case "header": {
      const header = await normalizeHeaderAuth(
        ctx,
        {
          authSecretId: input.authSecretId,
          authSecretName: input.authSecretName,
          authSecretValue: input.authSecretValue,
          authHeaderName: "Authorization",
          authValueTemplate: "Bearer {{secret}}",
        },
        { name },
      )
      auth.authSecretId = header.authSecretId
      auth.authHeaderName = header.authHeaderName
      auth.authValueTemplate = header.authValueTemplate
      newSecret = header.newSecret
      break
    }
    case "oauth": {
      const client = await normalizeOAuthClient(ctx, input, { name })
      auth.oauthClientId = client.oauthClientId
      auth.oauthClientSecretId = client.oauthClientSecretId
      auth.oauthScope = client.oauthScope
      auth.oauthAuthorizeParams = client.oauthAuthorizeParams
      newSecret = client.newSecret
      break
    }
    default:
      throw invalid("Choose how PCP signs in to the calendar server.")
  }

  return {
    data: {
      name,
      description,
      url,
      readOnly: input.readOnly,
      authType: input.authType,
      ...auth,
    },
    newSecret,
  }
}

export async function createCalendarAccount(
  ctx: VaultContext,
  input: CalendarAccountInput,
): Promise<{ id: string }> {
  const { data, newSecret } = await normalizeCalendarAccount(ctx, input)
  const id = newId()
  const slug = await uniqueSlug(ctx.vaultId, slugify(data.name))

  await withNewSecret(ctx, newSecret, async (secretId) => {
    await db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        kind: "caldav",
        slug,
        ...data,
        ...secretColumns(data, secretId),
      },
    })
  })

  return { id }
}

/** What reaching the account depends on; a change means checking it again. */
const CONNECTION_FIELDS = [
  "url",
  "authType",
  "authUsername",
  "authSecretId",
  "oauthClientId",
  "oauthClientSecretId",
  "oauthScope",
  "readOnly",
] as const

/**
 * Saves an account's settings. `reconnect` says it should be checked again:
 * its address, sign-in or what it may do changed.
 */
export async function updateCalendarAccount(
  ctx: VaultContext,
  id: string,
  input: CalendarAccountInput,
): Promise<{ reconnect: boolean }> {
  const existing = await getServer(ctx, id)

  if (existing.kind !== "caldav") {
    throw new PcpError(
      "state",
      `This is ${kindNoun(existing.kind)}; change it in its own settings.`,
    )
  }

  const { data, newSecret } = await normalizeCalendarAccount(ctx, input)
  const dropTokens = oauthTokensObsolete(existing, data)
  const reconnect =
    newSecret !== null ||
    CONNECTION_FIELDS.some((key) => data[key] !== existing[key])

  await withNewSecret(ctx, newSecret, (secretId) =>
    db().mcpServer.update({
      where: { id },
      data: {
        ...data,
        ...secretColumns(data, secretId),
        // The home the server named belongs to the old address or sign-in.
        ...(reconnect ? { davHomeUrl: null } : {}),
        ...(dropTokens
          ? { oauthTokensId: null, oauthConnectedAt: null, status: "unknown" }
          : {}),
      },
    }),
  )

  if (dropTokens && existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }

  return { reconnect }
}

/** The account's status and what the gateway is told, from a failure. */
async function fail(
  server: McpServer,
  error: unknown,
  credential: DavCredential,
): Promise<{ status: "auth_required" | "error"; message: string }> {
  const scrub = makeRedactor(credential.redact)

  if (error instanceof DavAuthError) {
    const message =
      server.authType === "oauth"
        ? `${server.name} needs to be connected: open it in PCP and choose Connect.`
        : `${server.name} refused the credentials PCP sent: ${scrub.text(error.message)}${server.url.includes("icloud.com") ? " iCloud takes an app-specific password (appleid.apple.com, Sign-In and Security), not your Apple ID password." : ""}`
    await setServerStatus(server.id, "auth_required", message)
    return { status: "auth_required", message }
  }

  const message = scrub
    .text(
      error instanceof Error
        ? `${server.name}: ${error.message}`
        : `${server.name} could not be reached.`,
    )
    .slice(0, 500)
  await setServerStatus(server.id, "error", message)
  return { status: "error", message }
}

/** The calendar home: as last found, or found now and kept. */
async function homeOf(
  server: McpServer,
  client: DavClient,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<string> {
  if (server.davHomeUrl && !fresh) {
    return server.davHomeUrl
  }

  const home = await client.discoverHome()
  await db().mcpServer.update({
    where: { id: server.id },
    data: { davHomeUrl: home },
  })
  server.davHomeUrl = home
  return home
}

/** The calendars, finding the home again once if it has moved. */
async function calendarsOf(
  server: McpServer,
  client: DavClient,
): Promise<CalendarInfo[]> {
  try {
    return await client.listCalendars(await homeOf(server, client))
  } catch (error) {
    if (
      error instanceof DavRequestError &&
      (error.cause === 404 || error.cause === 403) &&
      server.davHomeUrl
    ) {
      return client.listCalendars(await homeOf(server, client, { fresh: true }))
    }

    throw error
  }
}

/**
 * Finds the calendar home and its calendars, and writes the tools into the
 * catalogue. A failure keeps the tools it had.
 */
export async function syncCalendarTools(
  server: McpServer,
  credential: DavCredential,
): Promise<SyncResult> {
  try {
    const client = new DavClient(server.url, credential)
    const home = await homeOf(server, client, { fresh: true })
    const calendars = await client.listCalendars(home)

    if (calendars.length === 0) {
      throw new DavRequestError(
        "The account has no calendars or reminder lists PCP can read.",
      )
    }

    const toolCount = await storeTools(
      server.id,
      calendarTools({ readOnly: server.readOnly }),
    )
    await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })

    return { status: "ok", message: "", toolCount }
  } catch (error) {
    if (isPcpError(error)) {
      await setServerStatus(server.id, "error", error.message)
      return { status: "error", message: error.message, toolCount: 0 }
    }

    return { ...(await fail(server, error, credential)), toolCount: 0 }
  }
}

// ---------------------------------------------------------------------------
// Choosing calendars and objects

type Holds = CalendarInfo["holds"][number]

const HOLDS_NOUN: Record<Holds, string> = {
  events: "calendar",
  reminders: "reminder list",
}

function findCalendar(
  calendars: CalendarInfo[],
  named: string,
  holds: Holds,
): CalendarInfo {
  const wanted = named.trim()
  const found =
    calendars.find((calendar) => calendar.id === wanted) ??
    calendars.find(
      (calendar) => calendar.name.toLowerCase() === wanted.toLowerCase(),
    )

  if (!found) {
    throw new DavRequestError(
      `There is no ${HOLDS_NOUN[holds]} called "${wanted}". These are: ${
        calendars
          .filter((calendar) => calendar.holds.includes(holds))
          .map((calendar) => calendar.name)
          .join(", ") || "none"
      }.`,
    )
  }

  if (!found.holds.includes(holds)) {
    throw new DavRequestError(
      `${found.name} holds ${found.holds.join(" and ")}, not ${holds}.`,
    )
  }

  return found
}

/** The calendar to write to: the one named, or the first writable one. */
function writableCalendar(
  calendars: CalendarInfo[],
  named: string | undefined,
  holds: Holds,
): CalendarInfo {
  const calendar = named
    ? findCalendar(calendars, named, holds)
    : calendars.find((found) => found.holds.includes(holds) && found.writable)

  if (!calendar) {
    throw new DavRequestError(
      holds === "reminders"
        ? "This account has no reminder list PCP can write to. iCloud serves only the lists it keeps as tasks over CalDAV: lists upgraded in Apple's Reminders app stay in the app."
        : "This account has no calendar PCP can write to.",
    )
  }

  if (!calendar.writable) {
    throw new DavRequestError(`${calendar.name} is read-only.`)
  }

  return calendar
}

function calendarsHolding(
  calendars: CalendarInfo[],
  named: string | undefined,
  holds: Holds,
): CalendarInfo[] {
  return named
    ? [findCalendar(calendars, named, holds)]
    : calendars.filter((calendar) => calendar.holds.includes(holds))
}

/** The calendar and address an id (calendar/object) names. */
function objectRef(
  calendars: CalendarInfo[],
  id: string,
): { calendar: CalendarInfo; href: string; object: string } {
  const [calendarId, object] = id.split("/") as [string, string]
  const calendar = calendars.find((found) => found.id === calendarId)

  if (!calendar) {
    throw new DavRequestError(
      `There is no calendar ${calendarId} any more; list again for current ids.`,
    )
  }

  const base = calendar.href.endsWith("/") ? calendar.href : `${calendar.href}/`

  return { calendar, href: new URL(`./${object}`, base).toString(), object }
}

function objectHref(calendar: CalendarInfo, object: string): string {
  const base = calendar.href.endsWith("/") ? calendar.href : `${calendar.href}/`
  return new URL(`./${object}`, base).toString()
}

// ---------------------------------------------------------------------------
// Times

/** The zone an answer is given in and plain times are read in. */
function zoneFor(
  args: Record<string, unknown>,
  calendars: CalendarInfo[],
): string {
  return typeof args.timezone === "string"
    ? checkZone(args.timezone)
    : (calendars.find((calendar) => calendar.timezone)?.timezone ??
        machineZone())
}

/** A range's start: a date's midnight, or the time. */
function rangeStart(raw: string, zone: string, field: string): number {
  return inputInstant(parseTimeInput(raw, zone, field), intlZone(zone))
}

/** A range's end: a date counts in whole (the next midnight). */
function rangeEnd(raw: string, zone: string, field: string): number {
  const value = parseTimeInput(raw, zone, field)

  return value.kind === "date"
    ? inputInstant(
        { kind: "date", date: addDays(value.date, 1) },
        intlZone(zone),
      )
    : inputInstant(value, intlZone(zone))
}

function startOfToday(zone: string): number {
  const wall = instantToWall(intlZone(zone), Date.now())
  return wallToInstant(intlZone(zone), {
    ...wall,
    hour: 0,
    minute: 0,
    second: 0,
  })
}

function checkRange(from: number, to: number): void {
  if (to <= from) {
    throw invalid("to is not after from.")
  }

  if (to - from > MAX_RANGE_DAYS * 86_400_000) {
    throw invalid(`Look across at most ${MAX_RANGE_DAYS} days at once.`)
  }
}

// ---------------------------------------------------------------------------
// What an assistant is shown

function clip(text: string | null, max: number): string | null {
  return text === null || text.length <= max ? text : `${text.slice(0, max)}…`
}

function eventId(calendar: CalendarInfo, href: string): string {
  return `${calendar.id}/${lastSegment(href)}`
}

/** The last day an all-day event covers, from its exclusive end. */
function lastDay(start: TimeValue, end: TimeValue): TimeValue {
  if (start.kind !== "date" || end.kind !== "date") {
    return end
  }

  const last = addDays(end.date, -1)
  return Date.UTC(last.year, last.month - 1, last.day) >=
    Date.UTC(start.date.year, start.date.month - 1, start.date.day)
    ? { kind: "date", date: last }
    : start
}

function eventView(
  occurrence: Occurrence,
  calendar: CalendarInfo,
  href: string,
  display: Zone,
  { full }: { full: boolean },
) {
  const details = eventDetails(occurrence.event)
  const rule = ruleOf(occurrence.master)
  const own =
    occurrence.start.kind === "time" &&
    occurrence.start.tzid &&
    occurrence.start.zone.name !== display.name
      ? occurrence.start.zone.name
      : null

  return {
    id: eventId(calendar, href),
    ...(occurrence.occurrence ? { occurrence: occurrence.occurrence } : {}),
    calendar: calendar.name,
    calendarId: calendar.id,
    title: details.title,
    start: formatTime(occurrence.start, display),
    end: formatTime(lastDay(occurrence.start, occurrence.end), display),
    allDay: occurrence.start.kind === "date",
    ...(own ? { timezone: own } : {}),
    ...(details.location ? { location: details.location } : {}),
    ...(details.notes
      ? {
          notes: full
            ? details.notes
            : clip(details.notes, MAX_LISTED_NOTES_CHARS),
        }
      : {}),
    ...(details.url ? { url: details.url } : {}),
    ...(details.status && details.status !== "confirmed"
      ? { status: details.status }
      : {}),
    ...(details.availability === "free" ? { availability: "free" } : {}),
    ...(occurrence.recurring && rule ? { repeats: rule.summary } : {}),
    ...(details.attendees.length > 0 && !full
      ? { attendees: details.attendees.length }
      : {}),
    ...(full
      ? {
          availability: details.availability,
          ...(rule?.rule ? { rule: rule.rule } : {}),
          alerts: details.alerts,
          ...(details.organizer ? { organizer: details.organizer } : {}),
          attendees: details.attendees,
          ...(details.categories.length > 0
            ? { categories: details.categories }
            : {}),
          ...(occurrence.occurrence && occurrence.event !== occurrence.master
            ? { changedFromSeries: true }
            : {}),
        }
      : {}),
  }
}

function reminderView(
  reminder: ReminderView,
  calendar: CalendarInfo,
  href: string,
  display: Zone,
  { full }: { full: boolean },
) {
  const rule = ruleOf(reminder.todo)
  const alerts = alertsOf(reminder.todo)

  return {
    id: eventId(calendar, href),
    list: calendar.name,
    listId: calendar.id,
    title: reminder.title,
    due: reminder.due ? formatTime(reminder.due, display) : null,
    completed: reminder.completed,
    ...(reminder.completedAt ? { completedAt: reminder.completedAt } : {}),
    ...(reminder.priority ? { priority: reminder.priority } : {}),
    ...(reminder.notes
      ? {
          notes: full
            ? reminder.notes
            : clip(reminder.notes, MAX_LISTED_NOTES_CHARS),
        }
      : {}),
    ...(reminder.url ? { url: reminder.url } : {}),
    ...(rule ? { repeats: rule.summary } : {}),
    ...(alerts.minutesBefore.length > 0 || alerts.at.length > 0
      ? { alert: true }
      : {}),
  }
}

function calendarView(calendar: CalendarInfo) {
  return {
    id: calendar.id,
    name: calendar.name,
    holds: calendar.holds,
    writable: calendar.writable,
    ...(calendar.color ? { color: calendar.color } : {}),
    ...(calendar.timezone ? { timezone: calendar.timezone } : {}),
    ...(calendar.description ? { description: calendar.description } : {}),
  }
}

// ---------------------------------------------------------------------------
// The tools

type Session = {
  server: McpServer
  client: DavClient
  calendars: CalendarInfo[]
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** A text field: undefined leaves it, null (or "") clears it. */
function clearable(value: unknown): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : String(value)
}

/** The events of several calendars in a range, with the calendars that failed. */
async function eventsIn(
  session: Session,
  calendars: CalendarInfo[],
  range: { from: number; to: number },
  display: Zone,
) {
  const found: Array<{
    occurrence: Occurrence
    calendar: CalendarInfo
    href: string
  }> = []
  const skipped: Array<{ calendar: string; error: string }> = []
  let cut = false

  for (const calendar of calendars) {
    let objects: DavObject[]

    try {
      objects = await session.client.events(calendar, range)
    } catch (error) {
      if (error instanceof DavRequestError) {
        skipped.push({ calendar: calendar.name, error: error.message })
        continue
      }

      throw error
    }

    const fallback = calendar.timezone ? intlZone(calendar.timezone) : display

    for (const object of objects) {
      let expanded: ReturnType<typeof expandEvents>

      try {
        expanded = expandEvents(
          parseCalendarObject(object.data),
          range,
          fallback,
        )
      } catch {
        continue
      }

      cut ||= expanded.cut

      for (const occurrence of expanded.occurrences) {
        found.push({ occurrence, calendar, href: object.href })
      }
    }
  }

  found.sort(
    (a, b) =>
      a.occurrence.startMs - b.occurrence.startMs ||
      eventDetails(a.occurrence.event).title.localeCompare(
        eventDetails(b.occurrence.event).title,
      ),
  )

  return { found, skipped, cut }
}

function matchesText(text: string, ...fields: Array<string | null>): boolean {
  const needle = text.toLowerCase()
  return fields.some((field) => field?.toLowerCase().includes(needle))
}

const WEEKDAY_INDEX = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
} as const

/** The zone an existing event's times are best read and written in. */
function eventZone(
  data: string,
  calendar: CalendarInfo,
  args: Record<string, unknown>,
  display: string,
): string {
  if (typeof args.timezone === "string") {
    return checkZone(args.timezone)
  }

  const parsed = parseCalendarObject(data)
  const resolve = zoneBook(parsed, intlZone(display))
  const component =
    parsed.getFirstSubcomponent("vevent") ??
    parsed.getFirstSubcomponent("vtodo")
  const property =
    component?.getFirstProperty("dtstart") ?? component?.getFirstProperty("due")
  const tzid = property?.getParameter("tzid") as string | undefined

  if (tzid) {
    const zone = resolve(tzid)
    const known = intlZoneName(zone.name)

    if (known) {
      return known
    }
  }

  return calendar.timezone ?? display
}

function intlZoneName(name: string): string | null {
  try {
    return checkZone(name)
  } catch {
    return null
  }
}

function recurrenceArg(value: unknown): RecurrenceInput | null | undefined {
  return value === undefined ? undefined : (value as RecurrenceInput | null)
}

async function runTool(
  session: Session,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { client, calendars, server } = session

  switch (toolName) {
    case "list_calendars":
      return { calendars: calendars.map(calendarView) }

    case "list_events": {
      const scope = calendarsHolding(calendars, str(args.calendar), "events")
      const zone = zoneFor(args, scope)
      const display = intlZone(zone)
      const from = args.from
        ? rangeStart(String(args.from), zone, "from")
        : startOfToday(zone)
      const to = args.to
        ? rangeEnd(String(args.to), zone, "to")
        : from + DEFAULT_RANGE_DAYS * 86_400_000
      checkRange(from, to)

      const { found, skipped, cut } = await eventsIn(
        session,
        scope,
        { from, to },
        display,
      )
      const limit = (args.limit as number | undefined) ?? DEFAULT_EVENT_LIMIT
      const text = str(args.text)
      const matching = found.filter(({ occurrence }) => {
        const details = eventDetails(occurrence.event)

        return (
          details.status !== "cancelled" &&
          (!text ||
            matchesText(text, details.title, details.location, details.notes))
        )
      })

      return {
        from: formatInZone(display, from),
        to: formatInZone(display, to),
        timezone: zone,
        events: matching
          .slice(0, limit)
          .map(({ occurrence, calendar, href }) =>
            eventView(occurrence, calendar, href, display, { full: false }),
          ),
        ...(matching.length > limit
          ? {
              more: `${matching.length - limit} more in this span: ask for a shorter one, or a higher limit.`,
            }
          : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(cut
          ? {
              note: "A repeating event repeats too often to follow to the end; some of its occurrences may be missing.",
            }
          : {}),
      }
    }

    case "get_event": {
      const ref = objectRef(calendars, String(args.id))
      const object = await client.get(ref.href)
      const zone =
        typeof args.timezone === "string"
          ? checkZone(args.timezone)
          : (ref.calendar.timezone ?? machineZone())
      const display = intlZone(zone)
      const key =
        args.occurrence === undefined
          ? null
          : parseOccurrenceKey(String(args.occurrence))

      if (args.occurrence !== undefined && key === null) {
        throw invalid("occurrence: give it as list_events does.")
      }

      const occurrence = occurrenceOf(
        parseCalendarObject(object.data),
        key,
        ref.calendar.timezone ? intlZone(ref.calendar.timezone) : display,
      )

      if (!occurrence) {
        throw new DavRequestError(
          key
            ? "The event has no occurrence at that time; list_events gives each occurrence's id."
            : "That is not an event.",
        )
      }

      return {
        event: eventView(occurrence, ref.calendar, ref.href, display, {
          full: true,
        }),
      }
    }

    case "find_free_time": {
      const scope = (
        (args.calendars as string[] | undefined) ?? [undefined]
      ).flatMap((named) => calendarsHolding(calendars, named, "events"))
      const zone = zoneFor(args, scope)
      const display = intlZone(zone)
      const from = rangeStart(String(args.from), zone, "from")
      const to = rangeEnd(String(args.to), zone, "to")
      checkRange(from, to)

      const minutes = (args.duration_minutes as number | undefined) ?? 30
      const [startHour, startMinute] = (str(args.day_start) ?? "09:00")
        .split(":")
        .map(Number) as [number, number]
      const [endHour, endMinute] = (str(args.day_end) ?? "17:00")
        .split(":")
        .map(Number) as [number, number]
      const days = new Set<number>(
        (
          (args.weekdays as Array<keyof typeof WEEKDAY_INDEX> | undefined) ?? [
            "MO",
            "TU",
            "WE",
            "TH",
            "FR",
          ]
        ).map((day) => WEEKDAY_INDEX[day]),
      )

      if (endHour * 60 + endMinute <= startHour * 60 + startMinute) {
        throw invalid("day_end is not after day_start.")
      }

      const { found, skipped } = await eventsIn(
        session,
        scope,
        { from, to },
        display,
      )
      const busy = found
        .map(({ occurrence }) => ({
          occurrence,
          details: eventDetails(occurrence.event),
        }))
        .filter(
          ({ occurrence, details }) =>
            details.status !== "cancelled" &&
            details.availability === "busy" &&
            (args.include_all_day === true || occurrence.start.kind !== "date"),
        )
        .map(
          ({ occurrence }) => [occurrence.startMs, occurrence.endMs] as const,
        )
        .sort((a, b) => a[0] - b[0])

      const slots: Array<{ start: string; end: string; minutes: number }> = []
      const firstDay = instantToWall(display, from)
      let more = false

      for (let n = 0; ; n++) {
        const day = addDays(firstDay, n)
        const dayStart = wallToInstant(display, {
          ...day,
          hour: 0,
          minute: 0,
          second: 0,
        })

        if (dayStart >= to || slots.length > MAX_FREE_SLOTS) {
          break
        }

        if (
          !days.has(
            new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay(),
          )
        ) {
          continue
        }

        let cursor = Math.max(
          from,
          wallToInstant(display, {
            ...day,
            hour: startHour,
            minute: startMinute,
            second: 0,
          }),
        )
        const windowEnd = Math.min(
          to,
          endHour === 24
            ? wallToInstant(display, {
                ...addDays(day, 1),
                hour: 0,
                minute: 0,
                second: 0,
              })
            : wallToInstant(display, {
                ...day,
                hour: endHour,
                minute: endMinute,
                second: 0,
              }),
        )

        const push = (start: number, end: number) => {
          if (end - start >= minutes * 60_000) {
            if (slots.length >= MAX_FREE_SLOTS) {
              more = true
              return
            }

            slots.push({
              start: formatInZone(display, start),
              end: formatInZone(display, end),
              minutes: Math.round((end - start) / 60_000),
            })
          }
        }

        for (const [busyStart, busyEnd] of busy) {
          if (busyEnd <= cursor || busyStart >= windowEnd) {
            continue
          }

          if (busyStart > cursor) {
            push(cursor, Math.min(busyStart, windowEnd))
          }

          cursor = Math.max(cursor, busyEnd)

          if (cursor >= windowEnd) {
            break
          }
        }

        if (cursor < windowEnd) {
          push(cursor, windowEnd)
        }
      }

      return {
        timezone: zone,
        free: slots,
        ...(more
          ? { more: "There is more free time; ask for a shorter span." }
          : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        counted: `${busy.length} busy event${busy.length === 1 ? "" : "s"} in ${scope.map((calendar) => calendar.name).join(", ")}`,
      }
    }

    case "create_event": {
      const calendar = writableCalendar(calendars, str(args.calendar), "events")
      const zone =
        typeof args.timezone === "string"
          ? checkZone(args.timezone)
          : (calendar.timezone ?? machineZone())
      const start = parseTimeInput(String(args.start), zone, "start")
      let end: TimeInput

      if (args.end !== undefined) {
        end = parseTimeInput(String(args.end), zone, "end")

        if (end.kind !== start.kind) {
          throw invalid(
            "start and end are both dates (an all-day event) or both times.",
          )
        }

        if (
          start.kind === "date"
            ? inputInstant(end, intlZone(zone)) <
              inputInstant(start, intlZone(zone))
            : inputInstant(end, intlZone(zone)) <=
              inputInstant(start, intlZone(zone))
        ) {
          throw invalid("end is before start.")
        }
      } else if (start.kind === "date") {
        end = start
      } else {
        const minutes = (args.duration_minutes as number | undefined) ?? 60
        end = {
          kind: "time",
          wall: instantToWall(
            intlZone(zone),
            inputInstant(start, intlZone(zone)) + minutes * 60_000,
          ),
          zone,
        }
      }

      const uid = newUid()
      const object = `${uid}.ics`
      const href = objectHref(calendar, object)
      const data = newEventObject({
        uid,
        start,
        end,
        zone,
        fields: {
          title: String(args.title),
          location: clearable(args.location),
          notes: clearable(args.notes),
          url: clearable(args.url),
          alerts: args.alerts as number[] | undefined,
          availability: args.availability as "busy" | "free" | undefined,
          recurrence: recurrenceArg(args.recurrence),
        },
      })

      await client.put(href, data, { create: true })
      const occurrence = occurrenceOf(
        parseCalendarObject(data),
        null,
        intlZone(zone),
      )!

      return {
        created: eventView(occurrence, calendar, href, intlZone(zone), {
          full: true,
        }),
      }
    }

    case "update_event": {
      const ref = objectRef(calendars, String(args.id))
      const object = await client.get(ref.href)
      const zone = eventZone(
        object.data,
        ref.calendar,
        args,
        ref.calendar.timezone ?? machineZone(),
      )
      const key =
        args.occurrence === undefined
          ? null
          : parseOccurrenceKey(String(args.occurrence))

      if (args.occurrence !== undefined && key === null) {
        throw invalid("occurrence: give it as list_events does.")
      }

      const change: EventChange = {
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.start !== undefined
          ? { start: parseTimeInput(String(args.start), zone, "start") }
          : {}),
        ...(args.end !== undefined
          ? { end: parseTimeInput(String(args.end), zone, "end") }
          : {}),
        location: clearable(args.location),
        notes: clearable(args.notes),
        url: clearable(args.url),
        alerts: args.alerts as number[] | undefined,
        availability: args.availability as "busy" | "free" | undefined,
        recurrence: recurrenceArg(args.recurrence),
      }
      const scope = key
        ? ((args.scope as "this" | "all" | undefined) ?? "this")
        : "all"
      const fallback = ref.calendar.timezone
        ? intlZone(ref.calendar.timezone)
        : intlZone(zone)
      const changed = Object.keys(args).some(
        (name) =>
          !["id", "occurrence", "scope", "calendar", "timezone"].includes(name),
      )
        ? changeEvent(object.data, change, {
            occurrence: key,
            scope,
            fallback,
            zone,
          })
        : object.data
      let target = ref.calendar
      let href = ref.href

      if (args.calendar !== undefined) {
        target = writableCalendar(calendars, String(args.calendar), "events")
      }

      if (target.href !== ref.calendar.href) {
        // A move: written into the other calendar first, then taken out of
        // this one, so a failure in between leaves a copy, never nothing.
        href = objectHref(target, ref.object)
        await client.put(href, changed, { create: true })

        try {
          await client.delete(ref.href, object.etag)
        } catch (error) {
          throw new DavRequestError(
            `The event was copied to ${target.name}, but could not be taken out of ${ref.calendar.name}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } else {
        await client.put(ref.href, changed, { etag: object.etag })
      }

      const occurrence = occurrenceOf(
        parseCalendarObject(changed),
        scope === "this" ? key : null,
        fallback,
      )

      return {
        updated: occurrence
          ? eventView(occurrence, target, href, intlZone(zone), { full: true })
          : { id: eventId(target, href) },
      }
    }

    case "delete_event": {
      const ref = objectRef(calendars, String(args.id))
      const object = await client.get(ref.href)
      const display = intlZone(ref.calendar.timezone ?? machineZone())
      const key =
        args.occurrence === undefined
          ? null
          : parseOccurrenceKey(String(args.occurrence))

      if (args.occurrence !== undefined && key === null) {
        throw invalid("occurrence: give it as list_events does.")
      }

      const parsed = parseCalendarObject(object.data)
      const shown = occurrenceOf(parsed, key, display)

      if (key) {
        await client.put(
          ref.href,
          removeOccurrence(object.data, key, display),
          { etag: object.etag },
        )
      } else {
        await client.delete(ref.href, object.etag)
      }

      return {
        deleted: shown
          ? eventView(shown, ref.calendar, ref.href, display, { full: false })
          : { id: String(args.id) },
        ...(key
          ? {
              note: "Only this occurrence was deleted; the rest of the series stays.",
            }
          : {}),
      }
    }

    case "list_reminders": {
      const scope = calendarsHolding(calendars, str(args.list), "reminders")
      const zone = zoneFor(args, scope)
      const display = intlZone(zone)
      const status =
        (args.status as "open" | "completed" | "all" | undefined) ?? "open"
      const dueBefore = args.due_before
        ? rangeEnd(String(args.due_before), zone, "due_before")
        : null
      const text = str(args.text)
      const limit = (args.limit as number | undefined) ?? DEFAULT_REMINDER_LIMIT
      const found: Array<{
        reminder: ReminderView
        calendar: CalendarInfo
        href: string
        dueMs: number | null
      }> = []
      const skipped: Array<{ list: string; error: string }> = []

      for (const calendar of scope) {
        let objects: DavObject[]

        try {
          objects = await client.todos(calendar, {
            openOnly: status === "open",
          })
        } catch (error) {
          if (error instanceof DavRequestError) {
            skipped.push({ list: calendar.name, error: error.message })
            continue
          }

          throw error
        }

        const fallback = calendar.timezone
          ? intlZone(calendar.timezone)
          : display

        for (const object of objects) {
          let reminder: ReminderView | null

          try {
            reminder = readReminder(parseCalendarObject(object.data), fallback)
          } catch {
            continue
          }

          if (
            !reminder ||
            (status === "open" && reminder.completed) ||
            (status === "completed" && !reminder.completed)
          ) {
            continue
          }

          const dueMs = reminder.due ? instantOf(reminder.due, fallback) : null

          if (dueBefore !== null && (dueMs === null || dueMs >= dueBefore)) {
            continue
          }

          if (text && !matchesText(text, reminder.title, reminder.notes)) {
            continue
          }

          found.push({ reminder, calendar, href: object.href, dueMs })
        }
      }

      found.sort(
        (a, b) =>
          (a.dueMs ?? Number.MAX_SAFE_INTEGER) -
            (b.dueMs ?? Number.MAX_SAFE_INTEGER) ||
          a.reminder.title.localeCompare(b.reminder.title),
      )

      return {
        timezone: zone,
        reminders: found
          .slice(0, limit)
          .map(({ reminder, calendar, href }) =>
            reminderView(reminder, calendar, href, display, { full: false }),
          ),
        ...(found.length > limit
          ? {
              more: `${found.length - limit} more: narrow it, or ask for a higher limit.`,
            }
          : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(scope.length === 0
          ? {
              note: "This account has no reminder lists over CalDAV. iCloud serves only the lists it keeps as tasks: lists upgraded in Apple's Reminders app stay in the app.",
            }
          : {}),
      }
    }

    case "create_reminder": {
      const calendar = writableCalendar(calendars, str(args.list), "reminders")
      const zone =
        typeof args.timezone === "string"
          ? checkZone(args.timezone)
          : (calendar.timezone ?? machineZone())
      const uid = newUid()
      const href = objectHref(calendar, `${uid}.ics`)
      const data = newReminderObject({
        uid,
        zone,
        fallback: intlZone(zone),
        fields: { ...reminderFields(args, zone), title: String(args.title) },
      })

      await client.put(href, data, { create: true })
      const reminder = readReminder(parseCalendarObject(data), intlZone(zone))!

      return {
        created: reminderView(reminder, calendar, href, intlZone(zone), {
          full: true,
        }),
      }
    }

    case "update_reminder": {
      const ref = objectRef(calendars, String(args.id))
      const object = await client.get(ref.href)
      const zone = eventZone(
        object.data,
        ref.calendar,
        args,
        ref.calendar.timezone ?? machineZone(),
      )
      const fallback = intlZone(zone)
      let data = object.data
      const fields = reminderFields(args, zone)

      if (Object.values(fields).some((value) => value !== undefined)) {
        data = changeReminder(data, fields, { zone, fallback })
      }

      if (args.completed !== undefined) {
        data = completeReminder(data, Boolean(args.completed), fallback).data
      }

      let target = ref.calendar
      let href = ref.href

      if (args.list !== undefined) {
        target = writableCalendar(calendars, String(args.list), "reminders")
      }

      if (target.href !== ref.calendar.href) {
        href = objectHref(target, ref.object)
        await client.put(href, data, { create: true })

        try {
          await client.delete(ref.href, object.etag)
        } catch (error) {
          throw new DavRequestError(
            `The reminder was copied to ${target.name}, but could not be taken out of ${ref.calendar.name}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } else {
        await client.put(ref.href, data, { etag: object.etag })
      }

      const reminder = readReminder(parseCalendarObject(data), fallback)!
      return {
        updated: reminderView(reminder, target, href, fallback, { full: true }),
      }
    }

    case "complete_reminder": {
      const ids = Array.isArray(args.ids)
        ? args.ids.map(String)
        : [String(args.id)]
      const completed = args.completed !== false
      const done: unknown[] = []
      const failed: Array<{ id: string; error: string }> = []

      for (const id of ids) {
        try {
          const ref = objectRef(calendars, id)
          const object = await client.get(ref.href)
          const fallback = intlZone(ref.calendar.timezone ?? machineZone())
          const { data, next } = completeReminder(
            object.data,
            completed,
            fallback,
          )
          await client.put(ref.href, data, { etag: object.etag })
          const reminder = readReminder(parseCalendarObject(data), fallback)!
          done.push({
            ...reminderView(reminder, ref.calendar, ref.href, fallback, {
              full: false,
            }),
            ...(next
              ? {
                  note: `It repeats: it is due again ${formatTime(next, fallback)}.`,
                }
              : {}),
          })
        } catch (error) {
          if (error instanceof DavRequestError || isPcpError(error)) {
            failed.push({ id, error: error.message })
            continue
          }

          throw error
        }
      }

      if (!Array.isArray(args.ids)) {
        if (failed[0]) {
          throw new DavRequestError(failed[0].error)
        }

        return { reminder: done[0] }
      }

      return { done, failed }
    }

    case "delete_reminder": {
      const ref = objectRef(calendars, String(args.id))
      const object = await client.get(ref.href)
      const display = intlZone(ref.calendar.timezone ?? machineZone())
      const reminder = readReminder(parseCalendarObject(object.data), display)

      if (!reminder) {
        throw new DavRequestError("That is not a reminder.")
      }

      await client.delete(ref.href, object.etag)
      return {
        deleted: reminderView(reminder, ref.calendar, ref.href, display, {
          full: false,
        }),
      }
    }

    case "create_calendar": {
      const home = await homeOf(server, client)
      const href = await client.makeCalendar(home, newUid(), {
        name: String(args.name),
        component: args.holds === "reminders" ? "VTODO" : "VEVENT",
        color: str(args.color) ?? null,
      })
      const listed = (await client.listCalendars(home)).find(
        (calendar) => calendar.href === href,
      )

      return {
        calendar: listed
          ? calendarView(listed)
          : {
              id: lastSegment(href),
              name: String(args.name),
              holds: [args.holds],
              writable: true,
            },
      }
    }
  }

  throw new PcpError("state", `${server.name} has no tool called ${toolName}.`)
}

function reminderFields(
  args: Record<string, unknown>,
  zone: string,
): ReminderFields {
  return {
    title: args.title !== undefined ? String(args.title) : undefined,
    notes: clearable(args.notes),
    url: clearable(args.url),
    due:
      args.due === undefined
        ? undefined
        : args.due === null
          ? null
          : parseTimeInput(String(args.due), zone, "due"),
    priority: args.priority as ReminderFields["priority"],
    alert: args.alert as boolean | undefined,
    recurrence: recurrenceArg(args.recurrence),
  }
}

/** Runs one calendar tool for an assistant. */
export async function callCalendarTool(
  server: McpServer,
  toolName: string,
  rawArgs: Record<string, unknown>,
  { credential }: { credential: DavCredential },
): Promise<CallToolResult> {
  const spec = calendarToolSpec(toolName)

  if (!spec) {
    throw new PcpError(
      "state",
      `${server.name} has no tool called ${toolName}.`,
    )
  }

  if (server.readOnly && spec.writes) {
    throw new PcpError(
      "forbidden",
      `${server.name} is read-only in PCP; ${toolName} would change a calendar.`,
    )
  }

  // Checked before anything connects: a bad argument never reaches the
  // server.
  const args = parseCalendarArgs(spec, rawArgs)

  if (typeof args.timezone === "string") {
    checkZone(args.timezone)
  }

  // Times are read in their zone later; their form is checked now.
  for (const key of ["from", "to", "start", "end", "due", "due_before"]) {
    if (typeof args[key] === "string") {
      parseTimeInput(args[key], "UTC", key)
    }
  }

  const until = (args.recurrence as { until?: unknown } | null | undefined)
    ?.until

  if (typeof until === "string") {
    parseTimeInput(until, "UTC", "recurrence.until")
  }

  if (
    typeof args.occurrence === "string" &&
    parseOccurrenceKey(args.occurrence) === null
  ) {
    throw invalid("occurrence: give it as list_events does.")
  }

  try {
    const client = new DavClient(server.url, credential)
    const calendars = await calendarsOf(server, client)
    const value = await runTool({ server, client, calendars }, toolName, args)

    return jsonToolResult(value, { redact: credential.redact })
  } catch (error) {
    if (error instanceof DavRequestError) {
      return errorToolResult(error.message, { redact: credential.redact })
    }

    if (isPcpError(error)) {
      throw error
    }

    const failure = await fail(server, error, credential)
    throw new PcpError(
      failure.status === "auth_required" ? "unauthorized" : "upstream",
      failure.message,
    )
  }
}
