import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import { addSecret, allowAllTools, createToken } from "../lib/ui"

// A mail account, added in PCP and used by an assistant through /mcp: a
// JMAP server signed in with a user name and app password, the same behind
// OAuth through the Connect flow, a read-only account, a refused password
// and an IMAP server that is not there. The fake upstream's JMAP server
// records every request, which is how the tests see what PCP sent.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SECRET_NAME = `Mail password ${RUN}`
const NAME = `Mail ${RUN}`
const SLUG = `mail-${RUN}`
const OAUTH_NAME = `OAuth mail ${RUN}`
const OAUTH_SLUG = `oauth-mail-${RUN}`
const TOKEN_NAME = `Mail assistant ${RUN}`

let upstream: Upstream
let token: string
let accountId: string

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

  await page.goto("/servers")
  await page.getByRole("link", { name: "Add a mail account" }).click()
  await expect(page).toHaveURL(/\/servers\/mail\/new$/)
  await expect(
    page.getByLabel("JMAP: Stalwart, Fastmail, Cyrus and others"),
  ).toBeChecked()
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("Ada's mail at example.com.")
  // Not where the session is: PCP says what it found there.
  await page
    .getByLabel("Session URL")
    .fill(`${upstream.origin}/.well-known/jmap`)
  await page.getByLabel("User name").fill("ada@example.com")
  await page.getByLabel("Password").selectOption({ label: SECRET_NAME })
  await page.getByRole("button", { name: "Add mail account" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  accountId = page.url().split("/").pop()!
  await expect(page.getByText("Unreachable", { exact: true })).toBeVisible()
  await expect(
    page.getByText(/answered HTTP 404.*The session URL is usually/),
  ).toBeVisible()
  await expect(page.getByText("Tools (0)")).toBeVisible()

  await page.getByLabel("Session URL").fill(upstream.jmapSessionUrl)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. Signed in; 10 tools." }),
  ).toBeVisible()
  await page.reload()
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  await expect(page.getByText("Tools (10)")).toBeVisible()
  await expect(
    page.getByText(`Signs in at ${upstream.jmapSessionUrl}`),
  ).toBeVisible()
  expect(upstream.jmap.requests.at(-1)!.authorization).toBe(basic())

  // The secret names the account that uses it.
  await page.goto("/secrets")
  await expect(
    page.getByRole("listitem").filter({ hasText: SECRET_NAME }).getByText(NAME),
  ).toBeVisible()

  await page.goto("/servers")
  await expect(
    page.getByRole("link").filter({ hasText: NAME }).getByText("Ready"),
  ).toBeVisible()
})

test("an assistant reads, files and sends mail through the gateway", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)
  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain("MCP servers, APIs and mail accounts")
  expect(instructions).toContain(
    `${SLUG}: Ada's mail at example.com. (10 tools)`,
  )
  await allowAllTools(page, TOKEN_NAME, SLUG)

  const search = await callTool(baseURL!, token, "search_tools", {
    query: "read an email",
    server: SLUG,
  })
  expect(toolText(search)).toContain(`${SLUG}/get_email`)

  const boxes = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "list_mailboxes",
    }),
  )
  expect(boxes.mailboxes).toContainEqual(
    expect.objectContaining({ name: "Inbox", role: "inbox", unreadEmails: 1 }),
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

  // A long body: the start in the answer, the whole kept for read_result.
  const long = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "get_email",
      arguments: { id: "e3" },
    }),
  )
  const body = long.body as {
    truncated: boolean
    result: { $result: string; length: number }
  }
  expect(body.truncated).toBe(true)
  const end = await callTool(baseURL!, token, "read_result", {
    id: body.result.$result,
    offset: body.result.length - 14,
  })
  expect(toolText(end)).toMatch(/this is the end\]\nYours, Charles$/)

  const csv = json(
    await callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "get_attachment",
      arguments: { id: "e1", attachment: "blob-csv" },
    }),
  )
  expect(csv).toMatchObject({ name: "parts.csv", text: "part,count\ncog,42\n" })
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
  const described = await callTool(baseURL!, token, "read_result", {
    id: (png.result as { $result: string }).$result,
  })
  expect(toolText(described)).toMatch(/drawing\.png, image\/png, 12 bytes/)
  expect(toolText(described)).toContain("PCP does not show binary data")

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
    sent: { savedTo: "Sent", subject: "Re: The engine" },
  })
  expect(upstream.jmap.sent).toHaveLength(1)

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
  const everything = JSON.stringify([boxes, unread, long, csv, sent])
  expect(everything).not.toContain(upstream.expectedToken)
  expect(everything).not.toContain(basic().slice(6))
})

test("a read-only account offers the reading tools only", async ({ page }) => {
  await page.goto("/servers/mail/new")
  await page.getByLabel("Name", { exact: true }).fill(`Read-only mail ${RUN}`)
  await page.getByLabel("Session URL").fill(upstream.jmapSessionUrl)
  await page.getByLabel("User name").fill("ada@example.com")
  await page.getByLabel("Password").selectOption({ label: SECRET_NAME })
  await page.getByLabel("Read-only").check()
  await page.getByRole("button", { name: "Add mail account" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByText("Tools (6)")).toBeVisible()
  await expect(page.getByText("send_email", { exact: true })).toHaveCount(0)
  await expect(
    page.locator('[data-slot="badge"]', { hasText: "Read-only" }),
  ).toBeVisible()

  page.once("dialog", (dialog) => void dialog.accept())
  await page
    .getByRole("button", { name: `Remove Read-only mail ${RUN}` })
    .click()
  await expect(page).toHaveURL(/\/servers$/)
  await expect(page.getByText(`Read-only mail ${RUN}`)).toHaveCount(0)
})

test("a refused password and a missing IMAP server say so", async ({
  page,
}) => {
  await addSecret(page, {
    name: `Wrong password ${RUN}`,
    value: "not-the-password",
  })
  await page.goto("/servers/mail/new")
  await page.getByLabel("Name", { exact: true }).fill(`Wrong mail ${RUN}`)
  await page.getByLabel("Session URL").fill(upstream.jmapSessionUrl)
  await page.getByLabel("User name").fill("ada@example.com")
  await page
    .getByLabel("Password")
    .selectOption({ label: `Wrong password ${RUN}` })
  await page.getByRole("button", { name: "Add mail account" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(
    page.getByText("Credentials rejected", { exact: true }),
  ).toBeVisible()

  await page.goto("/servers/mail/new")
  await page.getByLabel("IMAP, with SMTP to send").check()
  await page.getByLabel("Name", { exact: true }).fill(`IMAP mail ${RUN}`)
  await page.getByLabel("IMAP server").fill("imaps://127.0.0.1:1")
  await page.getByLabel("User name").fill("ada@example.com")
  await page.getByLabel("Password").selectOption({ label: SECRET_NAME })
  await page.getByRole("button", { name: "Add mail account" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByText("Unreachable", { exact: true })).toBeVisible()
  await expect(page.getByText(/IMAP server could not be reached/)).toBeVisible()
  await expect(page.getByText("Signs in at imaps://127.0.0.1:1")).toBeVisible()
})

test("a JMAP account signs in with OAuth through Connect, and renews its token", async ({
  page,
  baseURL,
}) => {
  // Tokens that run out within PCP's margin: every use renews them first.
  upstream.tokenLifetime.seconds = 30

  await page.goto("/servers/mail/new")
  await page.getByLabel("Name", { exact: true }).fill(OAUTH_NAME)
  await page.getByLabel("Session URL").fill(upstream.oauthJmapSessionUrl)
  await page.getByLabel("Authentication").selectOption("oauth")
  await expect(page.getByTestId("oauth-redirect-url")).toBeVisible()
  await page.getByRole("button", { name: "Add mail account" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  const id = page.url().split("/").pop()!
  await expect(
    page.getByText("Needs connecting", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Tools (0)")).toBeVisible()
  expect(upstream.oauthJmap.requests).toHaveLength(0)

  await page.getByRole("link", { name: "Connect", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/servers/${id}\\?connected=1$`))
  await expect(page.getByText("Tools (10)")).toBeVisible()

  await allowAllTools(page, TOKEN_NAME, OAUTH_SLUG)
  const before = upstream.tokenRequests.filter(
    (request) => request.grant_type === "refresh_token",
  ).length
  const boxes = await callTool(baseURL!, token, "call_tool", {
    server: OAUTH_SLUG,
    tool: "list_mailboxes",
  })
  expect(boxes.body.result?.isError ?? false, toolText(boxes)).toBe(false)
  expect(
    upstream.tokenRequests.filter(
      (request) => request.grant_type === "refresh_token",
    ).length,
  ).toBeGreaterThan(before)
  expect(upstream.oauthJmap.requests.at(-1)!.authorization).toMatch(
    /^Bearer access-/,
  )
  upstream.tokenLifetime.seconds = 3600

  // Disconnected, the account answers with a way to connect it again.
  await page.goto(`/servers/${id}`)
  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect(
    page.getByText("Needs connecting", { exact: true }),
  ).toBeVisible()
  const disconnected = await callTool(baseURL!, token, "call_tool", {
    server: OAUTH_SLUG,
    tool: "list_mailboxes",
  })
  expect(toolText(disconnected)).toContain("needs connecting")
})

test("the account is shown in token scopes as mail", async ({ page }) => {
  await page.goto("/tokens")
  await page.getByLabel("Only these servers").check()
  await expect(
    page.getByRole("checkbox", { name: new RegExp(`^${NAME}`) }).locator(".."),
  ).toContainText("Mail")
  expect(accountId).toBeTruthy()
})
