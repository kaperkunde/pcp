import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import { addSecret, allowAllTools, createToken } from "../lib/ui"

// A mail account, added in PCP and used by an assistant through /mcp: a
// JMAP server signed in with a user name and app password, the same behind
// OAuth through the Connect flow, a read-only account, a refused password
// and an IMAP server that is not there; and accounts an assistant proposes
// through register_server, which the owner agrees to on PCP's page. The fake
// upstream's JMAP server records every request, which is how the tests see
// what PCP sent.
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
    result: { id: string; length: number }
  }
  expect(body.truncated).toBe(true)
  const end = await callTool(baseURL!, token, "read_result", {
    id: body.result.id,
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
  const png = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "get_attachment",
    arguments: { id: "e1", attachment: "blob-png" },
  })
  expect(png.body.result?.isError).toBe(true)
  expect(toolText(png)).toContain("text attachments only")

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

function permissionIn(text: string): { path: string; id: string } {
  const id = text.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, text).toBeTruthy()
  return { path: `/permissions/${id}`, id: id! }
}

test("an assistant proposes a JMAP account; the owner types the app password in PCP", async ({
  page,
  baseURL,
}) => {
  const proposed = `Proposed mail ${RUN}`
  const slug = `proposed-mail-${RUN}`
  const secretName = `Proposed mail password ${RUN}`

  // The server's address alone: PCP completes it, and shows the owner where.
  const first = await callTool(baseURL!, token, "register_server", {
    kind: "jmap",
    name: proposed,
    url: upstream.origin,
    auth_type: "basic",
    username: "ada@example.com",
    secret: secretName,
  })
  expect(first.body.result?.isError ?? false, toolText(first)).toBe(false)
  expect(toolText(first)).toContain("Not done yet")
  expect(toolText(first)).toContain(
    "They type the password for ada@example.com in there",
  )
  await page.goto(permissionIn(toolText(first)).path)
  await expect(
    page.getByText(`Add the mail account ${proposed}?`),
  ).toBeVisible()
  await expect(page.getByText("Protocol: JMAP", { exact: true })).toBeVisible()
  await expect(
    page.getByText(`Session URL: ${upstream.origin}/.well-known/jmap`),
  ).toBeVisible()
  await expect(page.getByText("User name: ada@example.com")).toBeVisible()
  // The fake server is on loopback, which PCP does not look at for an
  // assistant: the owner is told, and decides.
  await expect(
    page.getByText(/is, or resolves to, a private or local address/),
  ).toBeVisible()
  await page.getByRole("button", { name: "Not now" }).click()
  await expect(page.getByTestId("permission-outcome")).toBeVisible()
  expect(upstream.jmap.requests.length).toBeGreaterThan(0)
  const seen = upstream.jmap.requests.length

  // The session URL itself, with the password typed in on the page.
  const asked = await callTool(baseURL!, token, "register_server", {
    kind: "jmap",
    name: proposed,
    url: upstream.jmapSessionUrl,
    auth_type: "basic",
    username: "ada@example.com",
    secret: secretName,
    description: "Proposed by an assistant.",
  })
  const { path, id } = permissionIn(toolText(asked))
  // Nothing was sent to the server for a proposal, however it was made.
  expect(upstream.jmap.requests).toHaveLength(seen)

  await page.goto(path)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(
    page.getByText("Enter the password for ada@example.com first."),
  ).toBeVisible()
  await page
    .getByLabel("Password for ada@example.com")
    .fill(upstream.expectedToken)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed} as "${slug}" with 10 tools`,
  )
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `saved in PCP as "${secretName}"`,
  )

  // The assistant learns the outcome, never the password.
  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("10 tools")
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

  // The password is a secret of the owner's, used by the account.
  await page.goto("/secrets")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: secretName })
      .getByText(proposed),
  ).toBeVisible()
})

test("an assistant proposes a JMAP account with OAuth; PCP registers itself when the owner connects it", async ({
  page,
  baseURL,
}) => {
  const proposed = `Proposed OAuth mail ${RUN}`
  const slug = `proposed-oauth-mail-${RUN}`

  const asked = await callTool(baseURL!, token, "register_server", {
    kind: "jmap",
    name: proposed,
    url: upstream.oauthJmapSessionUrl,
    auth_type: "oauth",
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  const { path, id } = permissionIn(toolText(asked))

  await page.goto(path)
  await expect(
    page.getByText(`Add the mail account ${proposed}?`),
  ).toBeVisible()
  await expect(
    page.getByText(/^Authentication: OAuth; you sign in when you connect it/),
  ).toBeVisible()
  // No client to bring: PCP says how it finds one.
  await expect(
    page.getByText(/^Sign-in: PCP finds where the mail server signs you in/),
  ).toBeVisible()
  await expect(page.getByText(/Redirect URI your client needs/)).toHaveCount(0)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed}`,
  )

  // Added, and the assistant is told how to get it connected.
  const added = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(added)).toContain("needs connecting")
  expect(added.body.result?.structuredContent?.kind).toBe("connect")
  const connect = added.body.result!.structuredContent!.connect!
  expect(connect.slug).toBe(slug)
  // Nothing was sent to the mail server before the owner signed in.
  const before = upstream.oauthJmap.requests.length

  const registered = upstream.registrations.length
  const connected = callTool(baseURL!, token, "check_server", {
    server: connect.slug,
  })
  await page.goto(connect.startUrl)
  await expect(page).toHaveURL(
    new RegExp(`/servers/${connect.serverId}\\?connected=1$`),
  )
  expect(
    (await connected).body.result?.structuredContent?.server,
  ).toMatchObject({ connected: true, toolCount: 10 })
  expect(upstream.registrations).toHaveLength(registered + 1)
  expect(upstream.oauthJmap.requests.length).toBeGreaterThan(before)
  expect(upstream.oauthJmap.requests.at(-1)!.authorization).toMatch(
    /^Bearer access-/,
  )

  await allowAllTools(page, TOKEN_NAME, slug)
  const boxes = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "list_mailboxes",
  })
  expect(boxes.body.result?.isError ?? false, toolText(boxes)).toBe(false)
})

test("the account is shown in token scopes as mail", async ({ page }) => {
  await page.goto("/tokens")
  await page.getByLabel("Only these servers").check()
  await expect(
    page.getByRole("checkbox", { name: new RegExp(`^${NAME}`) }).locator(".."),
  ).toContainText("Mail")
  expect(accountId).toBeTruthy()
})
