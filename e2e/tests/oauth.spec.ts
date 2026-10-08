import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { allowAllTools, createToken } from "../lib/ui"

// An upstream behind OAuth, added from the Servers page's Add menu: PCP
// discovers the authorization server, registers itself, sends the owner's
// browser to sign in, comes back with a code, keeps the tokens encrypted,
// uses them for the assistant, and forgets them on Disconnect.
const RUN = Date.now().toString(36)
const SERVER_NAME = `OAuth postcards ${RUN}`

let upstream: Upstream

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("an OAuth server added from the Add menu is connected through the browser, serves the gateway, and is disconnected", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000)

  // The Add menu leads to every kind's own page.
  await page.goto("/servers")
  await page.getByRole("button", { name: "Add", exact: true }).click()
  const item = (name: string) =>
    page.getByRole("menuitem", { name: new RegExp(`^${name}`) })
  for (const [name, href] of [
    ["API endpoint", "/servers/endpoints/new"],
    ["Mail account", "/servers/mail/new"],
    ["SSH server", "/servers/ssh/new"],
    ["Wrapper", "/servers/wrappers/new"],
  ]) {
    await expect(item(name)).toHaveAttribute("href", href)
  }
  await item("MCP server").click()
  await expect(page).toHaveURL(/\/servers\/new$/)

  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.oauthMcpUrl)
  await page.getByLabel("Authentication").selectOption("oauth")
  await page.getByRole("button", { name: "Add server" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  const serverId = page.url().split("/").pop()!
  await expect(
    page.getByText("Needs connecting", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Tools (0)")).toBeVisible()

  // start → fake authorization server (approves at once) → callback → back.
  await page.getByRole("link", { name: "Connect", exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`/servers/${serverId}\\?connected=1$`),
  )
  await expect(
    page.getByRole("status").filter({ hasText: "Connected to" }),
  ).toBeVisible()
  await expect(page.getByText("Tools (3)")).toBeVisible()
  expect(upstream.issuedTokens.size).toBeGreaterThan(0)
  // The short name is under Advanced, with the rest of the settings.
  const slug = await page.getByLabel("Short name").inputValue()

  // The token set is a managed secret, visible but not editable.
  await page.goto("/secrets")
  const managed = page
    .getByRole("listitem")
    .filter({ hasText: `oauth/${serverId}` })
  await expect(managed.getByText("OAuth tokens", { exact: true })).toBeVisible()
  await expect(managed.getByRole("button", { name: "Edit" })).toHaveCount(0)

  // The gateway calls the upstream with the token PCP got.
  const token = await createToken(page, `OAuth assistant ${RUN}`)
  await allowAllTools(page, `OAuth assistant ${RUN}`, slug)
  const echoed = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "echo_auth",
    arguments: {},
  })
  expect(echoed.body.result?.isError ?? false, toolText(echoed)).toBe(false)
  // The server got the token PCP holds; its echo reaches the assistant
  // with the token taken out.
  const sent = upstream.calls.at(-1)?.authorization ?? ""
  expect(sent).toMatch(/^Bearer access-/)
  expect(toolText(echoed)).toContain("[redacted]")
  expect(toolText(echoed)).not.toContain(sent.replace("Bearer ", ""))
  expect(upstream.issuedTokens.has(sent.replace("Bearer ", ""))).toBe(true)

  // Disconnecting forgets the tokens.
  await page.goto(`/servers/${serverId}`)
  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Disconnected" }),
  ).toBeVisible()
  await expect(
    page.getByText("Needs connecting", { exact: true }),
  ).toBeVisible()

  await page.goto("/secrets")
  await expect(
    page.getByRole("listitem").filter({ hasText: `oauth/${serverId}` }),
  ).toHaveCount(0)
})
