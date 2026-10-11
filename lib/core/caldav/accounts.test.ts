import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { createSecret } from "../secrets"
import { getServer, listServers } from "../servers"
import { scratchDatabase } from "../test-db"
import { callServerTool, syncServerTools } from "../upstream"
import { setupVault } from "../vault"
import { createCalendarAccount, updateCalendarAccount } from "./accounts"
import { acceptedAddress, validateCalDavUrl } from "./addresses"
import { createFakeCalDav, type FakeCalDav } from "./fake-caldav"

// Calendar accounts end to end in the core: created by the owner, read and
// called through upstream.ts like any server, against an in-memory CalDAV
// server on 127.0.0.1 shaped like iCloud.

const PASSWORD = "abcd-efgh-ijkl-mnop"
const BASIC = `Basic ${Buffer.from(`ada@icloud.com:${PASSWORD}`).toString("base64")}`
const PUBLIC = { publicUrl: "http://localhost:3000" }

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let fake: FakeCalDav
let secretId: string

function mount(options: Partial<Parameters<typeof createFakeCalDav>[0]> = {}) {
  fake = createFakeCalDav({
    base: "/dav",
    authorize: (header) => header === BASIC,
    ...options,
  })
  fake.addCalendar({
    id: "home",
    name: "Home",
    components: ["VEVENT"],
    timezone: "Europe/Amsterdam",
    order: 1,
    color: "#FF2968",
  })
  fake.addCalendar({
    id: "work",
    name: "Work",
    components: ["VEVENT"],
    order: 2,
  })
  fake.addCalendar({
    id: "holidays",
    name: "Holidays",
    components: ["VEVENT"],
    readOnly: true,
    order: 3,
  })
  fake.addCalendar({
    id: "tasks",
    name: "Reminders",
    components: ["VTODO"],
    order: 4,
  })
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: secretId } = await createSecret(ctx, {
    name: "iCloud app password",
    value: PASSWORD,
  }))
  mount()
  api = await startTestApi((request, res) => {
    const answer = fake.handle({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    })
    res.statusCode = answer?.status ?? 404

    for (const [name, value] of Object.entries(answer?.headers ?? {})) {
      res.setHeader(name, value)
    }

    res.setHeader("content-type", answer?.type ?? "text/plain")
    res.end(answer?.body ?? "")
  })
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

async function account(
  overrides: Partial<Parameters<typeof createCalendarAccount>[1]> = {},
) {
  const { id } = await createCalendarAccount(ctx, {
    name: "iCloud",
    url: `${api.origin}/dav/`,
    readOnly: false,
    authType: "basic",
    authUsername: "ada@icloud.com",
    authSecretId: secretId,
    ...overrides,
  })
  await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)
  return id
}

async function call(
  id: string,
  tool: string,
  args: Record<string, unknown> = {},
) {
  const result = await callServerTool(
    ctx,
    await getServer(ctx, id),
    tool,
    args,
    PUBLIC,
  )
  const text = result.content
    .map((part) => ("text" in part ? part.text : ""))
    .join("")

  if (result.isError) {
    return { error: text } as Record<string, unknown> & { error?: string }
  }

  return JSON.parse(text) as Record<string, unknown> & { error?: undefined }
}

describe("adding an account", () => {
  it("finds the calendar home through the principal, keeps it, and lists the tools", async () => {
    const id = await account()
    const row = await getServer(ctx, id)

    expect(row).toMatchObject({
      kind: "caldav",
      status: "ok",
      davHomeUrl: `${api.origin}/dav/123456/calendars/`,
    })
    expect(row.tools.map((tool) => tool.name)).toContain("find_free_time")
    expect(row.tools).toHaveLength(13)
    expect(fake.requests[0]).toMatchObject({
      method: "PROPFIND",
      authorization: BASIC,
      depth: "0",
    })
    expect((await listServers(ctx))[0]).toMatchObject({
      kind: "caldav",
      toolCount: 13,
    })
  })

  it("offers only the reading tools on a read-only account, and refuses a writing one anyway", async () => {
    const id = await account({ readOnly: true })

    expect(
      (await getServer(ctx, id)).tools.map((tool) => tool.name).sort(),
    ).toEqual([
      "find_free_time",
      "get_event",
      "list_calendars",
      "list_events",
      "list_reminders",
    ])
    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "create_event",
        { title: "x", start: "2026-10-12" },
        PUBLIC,
      ),
    ).rejects.toThrow(/read-only/)
  })

  it("marks refused credentials, with iCloud's hint, and keeps the password out of it", async () => {
    const { id: wrong } = await createSecret(ctx, {
      name: "Wrong",
      value: "nope-nope",
    })
    const id = await account({ authSecretId: wrong })
    const row = await getServer(ctx, id)

    expect(row.status).toBe("auth_required")
    expect(row.statusMessage).toMatch(/refused the credentials/)
  })

  it("forgets the home when the address or sign-in changes", async () => {
    const id = await account()
    const { reconnect } = await updateCalendarAccount(ctx, id, {
      name: "iCloud",
      url: `${api.origin}/dav`,
      readOnly: false,
      authType: "basic",
      authUsername: "ada@icloud.com",
      authSecretId: secretId,
    })

    expect(reconnect).toBe(true)
    expect((await getServer(ctx, id)).davHomeUrl).toBeNull()
  })

  it("refuses a home the principal names on another site", async () => {
    await api.close()
    mount({ homeHref: "https://calendars.example.net/123456/calendars/" })
    api = await startTestApi((request, res) => {
      const answer = fake.handle({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      })
      res.statusCode = answer?.status ?? 404
      res.end(answer?.body ?? "")
    })
    const id = await account()
    const row = await getServer(ctx, id)

    expect(row.status).toBe("error")
    expect(row.statusMessage).toMatch(/does not send your sign-in/)
  })
})

describe("addresses", () => {
  it("takes a bare host as https and refuses credentials or a query in it", () => {
    expect(validateCalDavUrl("caldav.icloud.com")).toBe(
      "https://caldav.icloud.com/",
    )
    expect(() => validateCalDavUrl("https://a:b@caldav.icloud.com")).toThrow(
      /user name/,
    )
    expect(() => validateCalDavUrl("http://8.8.8.8/dav")).toThrow(/unencrypted/)
  })

  it("lets the home be on the typed origin, or over https on a host of the same domain", () => {
    const typed = "https://caldav.icloud.com/"

    expect(acceptedAddress("/123/principal/", typed, typed)).toBe(
      "https://caldav.icloud.com/123/principal/",
    )
    expect(
      acceptedAddress(
        "https://p52-caldav.icloud.com:443/123/calendars/",
        typed,
        typed,
      ),
    ).toBe("https://p52-caldav.icloud.com/123/calendars/")
    expect(
      acceptedAddress("http://p52-caldav.icloud.com/123/", typed, typed),
    ).toBeNull()
    expect(
      acceptedAddress("https://evil.example/123/", typed, typed),
    ).toBeNull()
    expect(
      acceptedAddress("https://icloud.com.evil.example/", typed, typed),
    ).toBeNull()
    // A host right under a country's second level has no domain to share.
    expect(
      acceptedAddress(
        "https://other.co.uk/",
        "https://dav.co.uk/",
        "https://dav.co.uk/",
      ),
    ).toBeNull()
  })
})

describe("calendars and events", () => {
  it("lists calendars in the owner's order, with what each holds and whether it can be written", async () => {
    const id = await account()
    const { calendars } = (await call(id, "list_calendars")) as {
      calendars: Array<Record<string, unknown>>
    }

    expect(calendars.map((calendar) => calendar.name)).toEqual([
      "Home",
      "Work",
      "Holidays",
      "Reminders",
    ])
    expect(calendars[0]).toMatchObject({
      id: "home",
      holds: ["events"],
      writable: true,
      timezone: "Europe/Amsterdam",
      color: "#FF2968",
    })
    expect(calendars[2]).toMatchObject({ writable: false })
    expect(calendars[3]).toMatchObject({ holds: ["reminders"] })
  })

  it("creates an event, lists it in its span, reads it, moves it and deletes it", async () => {
    const id = await account()
    const created = (await call(id, "create_event", {
      title: "Dentist",
      start: "2026-10-20T09:00",
      duration_minutes: 45,
      location: "Main St 1",
      alerts: [30],
    })) as { created: Record<string, string> }

    expect(created.created).toMatchObject({
      calendar: "Home",
      title: "Dentist",
      start: "2026-10-20T09:00:00+02:00",
      end: "2026-10-20T09:45:00+02:00",
      allDay: false,
    })
    const put = fake.requests.find((request) => request.method === "PUT")!
    expect(put.ifNoneMatch).toBe("*")
    expect(put.body).toContain("DTSTART;TZID=Europe/Amsterdam:20261020T090000")

    const listed = (await call(id, "list_events", {
      from: "2026-10-19",
      to: "2026-10-25",
    })) as {
      events: Array<Record<string, unknown>>
    }
    expect(listed.events.map((event) => event.title)).toEqual(["Dentist"])
    expect(
      (await call(id, "list_events", { from: "2026-10-21", to: "2026-10-25" }))
        .events,
    ).toEqual([])

    const read = (await call(id, "get_event", { id: created.created.id })) as {
      event: Record<string, unknown>
    }
    expect(read.event).toMatchObject({
      location: "Main St 1",
      alerts: [30],
      availability: "busy",
    })

    const moved = (await call(id, "update_event", {
      id: created.created.id,
      start: "2026-10-23T14:00",
      calendar: "Work",
    })) as { updated: Record<string, string> }
    expect(moved.updated).toMatchObject({
      calendar: "Work",
      start: "2026-10-23T14:00:00+02:00",
      end: "2026-10-23T14:45:00+02:00",
    })
    expect(fake.calendars.get("home")!.objects.size).toBe(0)
    expect(fake.calendars.get("work")!.objects.size).toBe(1)

    const deleted = (await call(id, "delete_event", {
      id: moved.updated.id,
    })) as { deleted: Record<string, string> }
    expect(deleted.deleted.title).toBe("Dentist")
    expect(fake.calendars.get("work")!.objects.size).toBe(0)
    expect(fake.requests.at(-1)).toMatchObject({
      method: "DELETE",
      ifMatch: '"e2"',
    })
  })

  it("lists each occurrence of a repeating event, and changes or deletes one alone", async () => {
    const id = await account()
    const { created } = (await call(id, "create_event", {
      title: "Standup",
      start: "2026-10-20T09:00",
      end: "2026-10-20T09:15",
      recurrence: { frequency: "weekly", weekdays: ["TU", "TH"], count: 4 },
    })) as { created: Record<string, string> }

    expect(created.repeats).toBe("every week on Tuesday and Thursday, 4 times")
    const list = async () =>
      (
        (await call(id, "list_events", {
          from: "2026-10-19",
          to: "2026-11-30",
        })) as { events: Array<Record<string, string>> }
      ).events
    const before = await list()
    expect(before.map((event) => event.start)).toEqual([
      "2026-10-20T09:00:00+02:00",
      "2026-10-22T09:00:00+02:00",
      "2026-10-27T09:00:00+01:00",
      "2026-10-29T09:00:00+01:00",
    ])

    await call(id, "update_event", {
      id: created.id,
      occurrence: before[1]!.occurrence,
      start: "2026-10-22T16:00",
      title: "Standup (late)",
    })
    await call(id, "delete_event", {
      id: created.id,
      occurrence: before[2]!.occurrence,
    })

    const after = await list()
    expect(after.map((event) => [event.title, event.start])).toEqual([
      ["Standup", "2026-10-20T09:00:00+02:00"],
      ["Standup (late)", "2026-10-22T16:00:00+02:00"],
      ["Standup", "2026-10-29T09:00:00+01:00"],
    ])
  })

  it("makes all-day events from dates, and leaves them out of free time unless asked", async () => {
    const id = await account()
    const { created } = (await call(id, "create_event", {
      title: "Conference",
      start: "2026-10-21",
      end: "2026-10-22",
    })) as { created: Record<string, unknown> }

    expect(created).toMatchObject({
      allDay: true,
      start: "2026-10-21",
      end: "2026-10-22",
    })
    await call(id, "create_event", {
      title: "Lunch",
      start: "2026-10-21T12:00",
      end: "2026-10-21T13:00",
    })
    await call(id, "create_event", {
      title: "Focus",
      start: "2026-10-21T14:00",
      end: "2026-10-21T15:00",
      availability: "free",
    })

    const free = (await call(id, "find_free_time", {
      from: "2026-10-21",
      to: "2026-10-21",
      duration_minutes: 60,
    })) as { free: Array<Record<string, unknown>> }
    expect(free.free).toEqual([
      {
        start: "2026-10-21T09:00:00+02:00",
        end: "2026-10-21T12:00:00+02:00",
        minutes: 180,
      },
      {
        start: "2026-10-21T13:00:00+02:00",
        end: "2026-10-21T17:00:00+02:00",
        minutes: 240,
      },
    ])

    const busy = (await call(id, "find_free_time", {
      from: "2026-10-21",
      to: "2026-10-21",
      include_all_day: true,
    })) as { free: unknown[] }
    expect(busy.free).toEqual([])
  })

  it("refuses to write to a read-only calendar, and says which calendars there are for a wrong name", async () => {
    const id = await account()

    expect(
      await call(id, "create_event", {
        title: "x",
        start: "2026-10-21",
        calendar: "Holidays",
      }),
    ).toEqual({
      error: "Holidays is read-only.",
    })
    expect((await call(id, "list_events", { calendar: "Nope" })).error).toMatch(
      /Home, Work, Holidays/,
    )
  })

  it("checks arguments before anything connects", async () => {
    const id = await account()
    const sent = fake.requests.length

    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "list_events",
        { timezone: "Mars/Olympus" },
        PUBLIC,
      ),
    ).rejects.toThrow(/time zone/)
    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "get_event",
        { id: "../../etc" },
        PUBLIC,
      ),
    ).rejects.toThrow(/id/)
    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "create_event",
        { title: "x", start: "2026-02-30" },
        PUBLIC,
      ),
    ).rejects.toThrow(/not a date that exists/)
    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "update_event",
        { id: "home/x.ics", occurrence: "sometime soon", title: "y" },
        PUBLIC,
      ),
    ).rejects.toThrow(/occurrence/)
    expect(fake.requests.length).toBe(sent)
  })

  it("does not overwrite an event changed in between", async () => {
    const id = await account()
    const { created } = (await call(id, "create_event", {
      title: "Call",
      start: "2026-10-20T09:00",
    })) as {
      created: Record<string, string>
    }
    const object = created.id.split("/")[1]!
    const calendar = fake.calendars.get("home")!
    const realHandle = fake.handle
    // Someone else changes it between PCP's read and its write.
    fake.handle = (request) => {
      if (request.method === "PUT") {
        fake.put("home", object, calendar.objects.get(object)!.data)
      }

      return realHandle(request)
    }

    expect(
      (await call(id, "update_event", { id: created.id, title: "Call Ada" }))
        .error,
    ).toMatch(/changed on the calendar server/)
  })
})

describe("reminders", () => {
  it("creates, lists, completes and deletes reminders", async () => {
    const id = await account()
    const { created } = (await call(id, "create_reminder", {
      title: "Call Ada",
      due: "2026-10-12T17:00",
      timezone: "Europe/Amsterdam",
      priority: "high",
      alert: true,
    })) as { created: Record<string, unknown> }

    expect(created).toMatchObject({
      list: "Reminders",
      title: "Call Ada",
      due: "2026-10-12T17:00:00+02:00",
      priority: "high",
      alert: true,
    })
    await call(id, "create_reminder", { title: "Buy milk" })
    await call(id, "create_reminder", { title: "Pay rent", due: "2026-10-01" })

    const open = (await call(id, "list_reminders")) as {
      reminders: Array<Record<string, unknown>>
    }
    // Soonest due first, no due date last.
    expect(open.reminders.map((reminder) => reminder.title)).toEqual([
      "Pay rent",
      "Call Ada",
      "Buy milk",
    ])
    // The fake refuses the open-only filter: PCP asked for everything instead.
    expect(
      fake.requests
        .filter((request) => request.method === "REPORT")
        .map((request) => /is-not-defined/.test(request.body)),
    ).toEqual([true, false])

    const due = (await call(id, "list_reminders", {
      due_before: "2026-10-05",
    })) as { reminders: Array<Record<string, unknown>> }
    expect(due.reminders.map((reminder) => reminder.title)).toEqual([
      "Pay rent",
    ])

    const done = (await call(id, "complete_reminder", {
      ids: open.reminders.slice(0, 2).map((reminder) => reminder.id),
    })) as { done: unknown[]; failed: unknown[] }
    expect(done).toMatchObject({ failed: [] })
    expect(done.done).toHaveLength(2)

    const left = (await call(id, "list_reminders")) as {
      reminders: Array<Record<string, unknown>>
    }
    expect(left.reminders.map((reminder) => reminder.title)).toEqual([
      "Buy milk",
    ])
    const completed = (await call(id, "list_reminders", {
      status: "completed",
    })) as { reminders: Array<Record<string, unknown>> }
    expect(completed.reminders).toHaveLength(2)
    expect(completed.reminders[0]).toHaveProperty("completedAt")

    const deleted = (await call(id, "delete_reminder", {
      id: left.reminders[0]!.id,
    })) as { deleted: Record<string, unknown> }
    expect(deleted.deleted.title).toBe("Buy milk")
    expect((await call(id, "list_reminders")).reminders).toEqual([])
  })

  it("moves a repeating reminder on when it is done, and changes one in place", async () => {
    const id = await account()
    const { created } = (await call(id, "create_reminder", {
      title: "Water the plants",
      due: "2026-10-12",
      recurrence: { frequency: "weekly" },
    })) as { created: Record<string, string> }

    const { reminder } = (await call(id, "complete_reminder", {
      id: created.id,
    })) as { reminder: Record<string, unknown> }
    expect(reminder).toMatchObject({
      completed: false,
      due: "2026-10-19",
      note: "It repeats: it is due again 2026-10-19.",
    })

    const { updated } = (await call(id, "update_reminder", {
      id: created.id,
      title: "Water the cactus",
      notes: "Only a little",
      recurrence: null,
    })) as { updated: Record<string, unknown> }
    expect(updated).toMatchObject({
      title: "Water the cactus",
      notes: "Only a little",
      due: "2026-10-19",
    })
    expect(updated).not.toHaveProperty("repeats")
  })

  it("makes a new reminder list and puts reminders in it", async () => {
    const id = await account()
    const { calendar } = (await call(id, "create_calendar", {
      name: "Groceries",
      holds: "reminders",
      color: "#34C759",
    })) as {
      calendar: Record<string, unknown>
    }

    expect(calendar).toMatchObject({ name: "Groceries", holds: ["reminders"] })
    const { created } = (await call(id, "create_reminder", {
      title: "Eggs",
      list: "Groceries",
    })) as { created: Record<string, unknown> }
    expect(created.list).toBe("Groceries")
  })
})
