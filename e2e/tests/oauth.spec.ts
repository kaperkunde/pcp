import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { createToken } from "../lib/ui"

// An upstream behind OAuth: PCP discovers the authorization server,
// registers itself, sends the owner's browser to sign in, comes back with
// a code, keeps the tokens encrypted, and uses them for the assistant.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SERVER_NAME = `OAuth postcards ${RUN}`

let upstream: Upstream
let serverId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("an OAuth server is added as needing a connection", async ({ page }) => {
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.oauthMcpUrl)
  await page.getByLabel("Authentication").selectOption("oauth")
  await page.getByRole("button", { name: "Add server" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  serverId = page.url().split("/").pop()!
  await expect(page.getByText("Needs connecting")).toBeVisible()
  await expect(page.getByText("Tools (0)")).toBeVisible()
})

test("connecting runs the OAuth flow and reads the tools", async ({ page }) => {
  await page.goto(`/servers/${serverId}`)
  await page.getByRole("link", { name: "Connect", exact: true }).click()

  // start → fake authorization server (approves at once) → callback → back.
  await expect(page).toHaveURL(
    new RegExp(`/servers/${serverId}\\?connected=1$`),
  )
  await expect(
    page.getByRole("status").filter({ hasText: "Connected to" }),
  ).toBeVisible()
  await expect(page.getByText("Tools (3)")).toBeVisible()
  expect(upstream.issuedTokens.size).toBeGreaterThan(0)

  // The token set is a managed secret, visible but not editable.
  await page.goto("/secrets")
  const managed = page
    .getByRole("listitem")
    .filter({ hasText: `oauth/${serverId}` })
  await expect(managed.getByText("OAuth tokens", { exact: true })).toBeVisible()
  await expect(managed.getByRole("button", { name: "Edit" })).toHaveCount(0)
})

test("the gateway calls the upstream with the OAuth token", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, `OAuth assistant ${RUN}`)
  const slug = (await page
    .goto(`/servers/${serverId}`)
    .then(() => page.getByLabel("Short name").inputValue()))!

  const echoed = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "echo_auth",
    arguments: {},
  })
  expect(echoed.body.result?.isError ?? false, toolText(echoed)).toBe(false)
  const sent = toolText(echoed)
  expect(sent).toMatch(/^Bearer access-/)
  expect(upstream.issuedTokens.has(sent.replace("Bearer ", ""))).toBe(true)
})

test("disconnecting forgets the tokens", async ({ page }) => {
  await page.goto(`/servers/${serverId}`)
  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Disconnected" }),
  ).toBeVisible()
  await expect(page.getByText("Needs connecting")).toBeVisible()

  await page.goto("/secrets")
  await expect(
    page.getByRole("listitem").filter({ hasText: `oauth/${serverId}` }),
  ).toHaveCount(0)
})
