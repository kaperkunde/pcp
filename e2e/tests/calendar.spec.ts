import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import { allowAllTools, createToken } from "../lib/ui"

// A calendar account, added in PCP and used by an assistant through /mcp: a
// CalDAV server shaped like iCloud's, signed in with a user name and an app
// password typed into the form; events and reminders through the gateway;
// and an account an assistant proposes through register_server, whose
// password the owner types in on PCP's page. The fake upstream's CalDAV
// server records every request, which is how the tests see what PCP sent.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `Calendar ${RUN}`
const SLUG = `calendar-${RUN}`
const TOKEN_NAME = `Calendar assistant ${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

function basic(): string {
  return `Basic ${Buffer.from(`ada@icloud.com:${upstream.expectedToken}`).toString("base64")}`
}

function json(response: Awaited<ReturnType<typeof callTool>>) {
  expect(response.body.result?.isError ?? false, toolText(response)).toBe(false)
  return JSON.parse(toolText(response)) as Record<string, unknown>
}

test("a calendar account is added with a user name and an app password typed in", async ({
  page,
}) => {
  await page.goto("/servers/calendars/new")
  await expect(page.getByRole("radio", { name: "iCloud" })).toBeChecked()
  await expect(page.getByLabel("CalDAV server")).toHaveValue(
    "https://caldav.icloud.com/",
  )

  await page.getByRole("radio", { name: "Other CalDAV" }).check()
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("Ada's calendars and reminders.")
  await page.getByLabel("CalDAV server").fill(upstream.caldavUrl)
  await page.getByLabel("User name", { exact: true }).fill("ada@icloud.com")
  await page
    .getByLabel("Password", { exact: true })
    .selectOption({ label: "A new password, entered here" })
  await page.getByLabel("New password").fill(upstream.expectedToken)
  await page.getByRole("button", { name: "Add calendar account" }).click()

  // PCP signed in and found the calendars on the way in.
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByText("Calendar account").first()).toBeVisible()
  await expect(page.getByText("13 tools")).toBeVisible()
  expect(upstream.caldav.requests.length).toBeGreaterThan(0)
  expect(
    upstream.caldav.requests.every(
      (request) => request.authorization === basic(),
    ),
  ).toBe(true)
})

test("an assistant plans a day and keeps reminders through the gateway", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)
  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(
    `${SLUG}: Ada's calendars and reminders. (13 tools)`,
  )
  await allowAllTools(page, TOKEN_NAME, SLUG)

  const call = (tool: string, args: Record<string, unknown> = {}) =>
    callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool,
      arguments: args,
    })

  const { calendars } = json(await call("list_calendars")) as {
    calendars: Array<Record<string, unknown>>
  }
  expect(calendars.map((calendar) => calendar.name)).toEqual([
    "Home",
    "Holidays",
    "Reminders",
  ])

  const created = json(
    await call("create_event", {
      title: "Dentist",
      start: "2030-03-12T10:00",
      duration_minutes: 30,
      alerts: [60],
    }),
  ).created as Record<string, string>
  expect(created).toMatchObject({
    calendar: "Home",
    start: "2030-03-12T10:00:00+01:00",
    end: "2030-03-12T10:30:00+01:00",
  })

  const free = json(
    await call("find_free_time", {
      from: "2030-03-12",
      to: "2030-03-12",
      duration_minutes: 60,
    }),
  )
  expect(free.free).toEqual([
    {
      start: "2030-03-12T09:00:00+01:00",
      end: "2030-03-12T10:00:00+01:00",
      minutes: 60,
    },
    {
      start: "2030-03-12T10:30:00+01:00",
      end: "2030-03-12T17:00:00+01:00",
      minutes: 390,
    },
  ])

  const moved = json(
    await call("update_event", { id: created.id, start: "2030-03-13T15:00" }),
  ).updated as Record<string, string>
  expect(moved.start).toBe("2030-03-13T15:00:00+01:00")
  const listed = json(
    await call("list_events", { from: "2030-03-11", to: "2030-03-15" }),
  ).events as Array<Record<string, string>>
  expect(listed.map((event) => [event.title, event.start])).toEqual([
    ["Dentist", "2030-03-13T15:00:00+01:00"],
  ])

  // A subscription is read-only: the assistant is told, nothing is written.
  const refused = await call("create_event", {
    title: "Day off",
    start: "2030-03-14",
    calendar: "Holidays",
  })
  expect(refused.body.result?.isError).toBe(true)
  expect(toolText(refused)).toBe("Holidays is read-only.")

  const reminder = json(
    await call("create_reminder", {
      title: "Book the train",
      due: "2030-03-10",
      priority: "high",
    }),
  ).created as Record<string, string>
  expect(reminder).toMatchObject({ list: "Reminders", due: "2030-03-10" })
  json(await call("complete_reminder", { id: reminder.id }))
  expect(json(await call("list_reminders")).reminders).toEqual([])

  // Every request carried the password, and no answer did.
  expect(
    upstream.caldav.requests.every(
      (request) => request.authorization === basic(),
    ),
  ).toBe(true)
  expect(JSON.stringify(listed)).not.toContain(upstream.expectedToken)
})

test("an assistant proposes a calendar account, and the owner types its password in", async ({
  page,
  baseURL,
}) => {
  const proposed = `Proposed calendar ${RUN}`
  const slug = `proposed-calendar-${RUN}`
  const secretName = `Proposed calendar password ${RUN}`
  const seen = upstream.caldav.requests.length

  const asked = await callTool(baseURL!, token, "register_server", {
    kind: "caldav",
    name: proposed,
    url: upstream.caldavUrl,
    auth_type: "basic",
    username: "ada@icloud.com",
    secret: secretName,
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()
  // Nothing was sent to the server for a proposal.
  expect(upstream.caldav.requests).toHaveLength(seen)

  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText(`Add the calendar account ${proposed}?`),
  ).toBeVisible()
  await page
    .getByLabel("Password for ada@icloud.com")
    .fill(upstream.expectedToken)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed} as "${slug}" with 13 tools`,
  )

  const outcome = await callTool(baseURL!, token, "check_permission", {
    id: id!,
  })
  expect(toolText(outcome)).toContain("13 tools")
  expect(toolText(outcome)).not.toContain(upstream.expectedToken)
  expect(upstream.caldav.requests.at(-1)!.authorization).toBe(basic())
})
