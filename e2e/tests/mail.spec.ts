import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import { addSecret, allowAllTools, createToken } from "../lib/ui"

// A mail account, added in PCP and used by an assistant through /mcp: a
// JMAP server signed in with a user name and app password, a read-only
// account, and an account an assistant proposes through register_server,
// whose password the owner types in on PCP's page. The fake upstream's JMAP
// server records every request, which is how the tests see what PCP sent.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SECRET_NAME = `Mail password ${RUN}`
const NAME = `Mail ${RUN}`
const SLUG = `mail-${RUN}`
const READ_ONLY_NAME = `Read-only mail ${RUN}`
const READ_ONLY_SLUG = `read-only-mail-${RUN}`
const TOKEN_NAME = `Mail assistant ${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

function basic(): string {
  return `Basic ${Buffer.from(`ada@example.com:${upstream.expectedToken}`).toString("base64")}`
}

function json(response: Awaited<ReturnType<typeof callTool>>) {
  expect(response.body.result?.isError ?? false, toolText(response)).toBe(false)
  return JSON.parse(toolText(response)) as Record<string, unknown>
}

test("a JMAP account is added with a user name and an app password", async ({
  page,
}) => {
  await addSecret(page, { name: SECRET_NAME, value: upstream.expectedToken })

  await page.goto("/servers/mail/new")
  await expect(page.getByRole("radio", { name: "JMAP" })).toBeChecked()
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("Ada's mail at example.com.")
  await page.getByLabel("Session URL").fill(upstream.jmapSessionUrl)
  await expect(
    page.getByRole("radio", { name: "User name and password" }),
  ).toBeChecked()
  await page.getByLabel("User name", { exact: true }).fill("ada@example.com")
  await page
    .getByLabel("Password", { exact: true })
    .selectOption({ label: SECRET_NAME })
  await page.getByRole("button", { name: "Add mail account" }).click()

  // PCP signed in on the way in, with the password.
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  expect(upstream.jmap.requests.length).toBeGreaterThan(0)
  expect(upstream.jmap.requests.at(-1)!.authorization).toBe(basic())
})

test("an assistant reads, files and sends mail through the gateway", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)
  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(
    `${SLUG}: Ada's mail at example.com. (16 tools)`,
  )
  await allowAllTools(page, TOKEN_NAME, SLUG)

  const boxes = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "list_mailboxes",
    }),
  )
  expect(boxes.mailboxes).toContainEqual(
    expect.objectContaining({ name: "Inbox", role: "inbox" }),
  )

  const unread = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "search_emails",
      arguments: { unread: true },
    }),
  )
  expect(unread).toMatchObject({
    total: 1,
    emails: [{ id: "e1", subject: "The engine" }],
  })

  // A file is not shown: it is kept, and its handle stands for it.
  const png = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "get_attachment",
      arguments: { id: "e1", attachment: "blob-png" },
    }),
  )
  expect(png).toMatchObject({
    name: "drawing.png",
    result: { type: "image/png", size: 12, name: "drawing.png" },
  })
  expect(png).not.toHaveProperty("text")

  const sent = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "send_email",
      arguments: {
        to: ["Charles Babbage <charles@example.com>"],
        subject: "Re: The engine",
        text: "Thursday suits me.",
        inReplyTo: "e1",
      },
    }),
  )
  expect(sent).toMatchObject({
    sent: { savedTo: "Sent", subject: "Re: The engine", answered: true },
  })
  expect(upstream.jmap.sent).toHaveLength(1)

  // The picture read above goes out as an attachment, by its handle.
  const forwarded = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "send_email",
      arguments: {
        to: ["charles@example.com"],
        subject: "The drawing",
        text: "Here it is.",
        attachments: [{ $result: (png.result as { $result: string }).$result }],
      },
    }),
  )
  expect(forwarded).toMatchObject({ sent: { subject: "The drawing" } })
  expect(
    upstream.jmap.requests.filter((request) =>
      request.path.startsWith("/jmap/upload/"),
    ),
  ).toEqual([
    expect.objectContaining({
      method: "POST",
      authorization: basic(),
      body: "12 bytes",
    }),
  ])

  // Nothing deletes mail for good: delete moves it to the Trash.
  json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "move_email",
      arguments: { id: "e2", mailbox: "archive" },
    }),
  )
  json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "delete_email",
      arguments: { id: "e1" },
    }),
  )
  const archived = upstream.jmap.emails.find((email) => email.id === "e2")!
  const trashed = upstream.jmap.emails.find((email) => email.id === "e1")!
  expect(archived.mailboxIds).toEqual({ "mb-archive": true })
  expect(trashed.mailboxIds).toEqual({ "mb-trash": true })

  // A bad argument never reaches the server.
  const before = upstream.jmap.requests.length
  const bad = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "send_email",
    arguments: {
      to: ["a@example.com\r\nBcc: eve@example.com"],
      subject: "x",
      text: "y",
    },
  })
  expect(bad.body.result?.isError).toBe(true)
  expect(upstream.jmap.requests.length).toBe(before)

  // Every request carried the password, and no answer did.
  expect(
    upstream.jmap.requests.every(
      (request) => request.authorization === basic(),
    ),
  ).toBe(true)
  const everything = JSON.stringify([boxes, unread, png, sent, forwarded])
  expect(everything).not.toContain(upstream.expectedToken)
  expect(everything).not.toContain(basic().slice(6))
})

test("a read-only account cannot send", async ({ page, baseURL }) => {
  await page.goto("/servers/mail/new")
  await page.getByLabel("Name", { exact: true }).fill(READ_ONLY_NAME)
  await page.getByLabel("Session URL").fill(upstream.jmapSessionUrl)
  await page.getByLabel("User name", { exact: true }).fill("ada@example.com")
  await page
    .getByLabel("Password", { exact: true })
    .selectOption({ label: SECRET_NAME })
  await page.getByLabel("Read-only").check()
  await page.getByRole("button", { name: "Add mail account" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)

  await allowAllTools(page, TOKEN_NAME, READ_ONLY_SLUG)
  const sentBefore = upstream.jmap.sent.length
  const refused = await callTool(baseURL!, token, "call_tool", {
    server: READ_ONLY_SLUG,
    tool: "send_email",
    arguments: { to: ["charles@example.com"], subject: "x", text: "y" },
  })
  expect(refused.body.result?.isError).toBe(true)
  expect(upstream.jmap.sent).toHaveLength(sentBefore)

  // Reading still works.
  json(
    await callTool(baseURL!, token, "call_tool", {
      server: READ_ONLY_SLUG,
      tool: "list_mailboxes",
    }),
  )
})

test("an assistant proposes a JMAP account; the owner types the app password in PCP", async ({
  page,
  baseURL,
}) => {
  const proposed = `Proposed mail ${RUN}`
  const slug = `proposed-mail-${RUN}`
  const secretName = `Proposed mail password ${RUN}`
  const seen = upstream.jmap.requests.length

  const asked = await callTool(baseURL!, token, "register_server", {
    kind: "jmap",
    name: proposed,
    url: upstream.jmapSessionUrl,
    auth_type: "basic",
    username: "ada@example.com",
    secret: secretName,
    description: "Proposed by an assistant.",
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  expect(toolText(asked)).toContain(
    "They type the password for ada@example.com in there",
  )
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()
  // Nothing was sent to the server for a proposal.
  expect(upstream.jmap.requests).toHaveLength(seen)

  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText(`Add the mail account ${proposed}?`),
  ).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(
    page.getByText("Enter the password for ada@example.com first."),
  ).toBeVisible()
  await page
    .getByLabel("Password for ada@example.com")
    .fill(upstream.expectedToken)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed} as "${slug}" with 16 tools`,
  )
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `saved in PCP as "${secretName}"`,
  )

  // The assistant learns the outcome, never the password.
  const outcome = await callTool(baseURL!, token, "check_permission", {
    id: id!,
  })
  expect(toolText(outcome)).toContain("16 tools")
  expect(toolText(outcome)).not.toContain(upstream.expectedToken)
  expect(upstream.jmap.requests.at(-1)!.authorization).toBe(basic())

  // Its tools ask first, like any server's; allowed, they work.
  await allowAllTools(page, TOKEN_NAME, slug)
  const boxes = json(
    await callTool(baseURL!, token, "call_tool", {
      server: slug,
      tool: "list_mailboxes",
    }),
  )
  expect(JSON.stringify(boxes)).toContain("Inbox")
  expect(JSON.stringify(boxes)).not.toContain(upstream.expectedToken)
})
