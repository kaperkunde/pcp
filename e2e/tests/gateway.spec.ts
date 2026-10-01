import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { OWNER_PASSWORD } from "../lib/auth"
import { callTool, initialize, mcpRequest, toolText } from "../lib/mcp"
import {
  addSecret,
  allowAllTools,
  confirmWithPassword,
  createToken,
  openToken,
  showTools,
} from "../lib/ui"

// The whole point of PCP in one flow: a secret goes in, a server is added
// that needs it, an assistant with an API token finds and calls the
// server's tools through /mcp, and the secret reaches the upstream — and
// only the upstream.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SECRET_NAME = `Upstream key ${RUN}`
const SERVER_NAME = `Postcards ${RUN}`
const SLUG = `postcards-${RUN}`

let upstream: Upstream
let token: string
let serverId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("refuses the gateway without a token", async ({ baseURL }) => {
  const response = await mcpRequest(baseURL!, null, "tools/list")
  expect(response.status).toBe(401)
  expect(response.wwwAuthenticate).toContain("Bearer")

  const wrong = await mcpRequest(baseURL!, "pcp_not-a-token", "tools/list")
  expect(wrong.status).toBe(401)
})

test("adds a server that authenticates with a stored secret", async ({
  page,
}) => {
  await addSecret(page, { name: SECRET_NAME, value: upstream.expectedToken })

  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.mcpUrl)
  await page.getByLabel("Description").fill("Sends postcards and adds numbers.")
  await page.getByLabel("Authentication").selectOption("header")
  await page.getByLabel("Secret").selectOption({ label: SECRET_NAME })
  await page.getByRole("button", { name: "Add server" }).click()

  // PCP read the tool list on the way in.
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  serverId = page.url().split("/").pop()!
  await expect(page.getByText("Connected")).toBeVisible()
  await expect(page.getByText("Tools (3)")).toBeVisible()
  await expect(page.locator("code", { hasText: "echo_auth" })).toBeVisible()

  // The short name defaults to the slugified name; set the one the tests use.
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()
})

test("lets the owner rewrite a tool's description", async ({ page }) => {
  await page.goto(`/servers/${serverId}`)
  const row = page.getByRole("listitem").filter({ hasText: "send_postcard" })
  await row.getByRole("button", { name: "Edit description" }).click()
  await row
    .getByLabel("Description of send_postcard")
    .fill("Posts a physical greeting card to a street address.")
  await row.getByRole("button", { name: "Save description" }).click()
  await expect(
    row.getByText("Posts a physical greeting card to a street address."),
  ).toBeVisible()
  await expect(row.getByText("edited")).toBeVisible()
})

test("a token is only made with the password", async ({ page }) => {
  // The session alone must not be enough to mint a lasting way in.
  await page.goto("/tokens")
  await page.getByLabel("Name").fill(`Unconfirmed ${RUN}`)
  await page.getByRole("button", { name: "Create token" }).click()
  await confirmWithPassword(page, "not the password")
  await expect(page.locator("p[role=alert]")).toHaveText(/not right/)
  await expect(page.getByText("Your new token")).toHaveCount(0)

  await page.reload()
  await expect(
    page.getByRole("listitem").filter({ hasText: `Unconfirmed ${RUN}` }),
  ).toHaveCount(0)
})

test("issues an API token and describes the servers behind it", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, `Assistant ${RUN}`)

  const { instructions, tools, serverInfo } = await initialize(baseURL!, token)
  expect(tools).toEqual([
    "search_tools",
    "describe_tool",
    "call_tool",
    "check_permission",
    "check_server",
    "register_server",
    "propose_tool_access",
  ])
  expect(instructions).toContain(
    `${SLUG}: Sends postcards and adds numbers. (3 tools)`,
  )

  // The app shows PCP's icon beside the gateway, served from PCP itself.
  const icon = serverInfo?.icons?.find((entry) =>
    entry.sizes?.includes("192x192"),
  )
  expect(icon?.src).toBe(`${baseURL}/icons/icon-192.png`)
  const image = await fetch(icon!.src)
  expect(image.status).toBe(200)
  expect(image.headers.get("content-type")).toBe("image/png")

  // Tools ask the owner first by default (permissions.spec.ts covers that);
  // this spec is about the gateway, so let the token run them.
  await allowAllTools(page, `Assistant ${RUN}`, SLUG)
})

test("finds, describes and calls an upstream tool with the secret added by PCP", async ({
  baseURL,
}) => {
  const search = await callTool(baseURL!, token, "search_tools", {
    query: "post a greeting card",
  })
  expect(search.body.result?.isError ?? false, toolText(search)).toBe(false)
  // Earlier runs against the same database leave identical servers behind,
  // which tie with this one; the line for this run's server is what counts.
  const line = toolText(search)
    .split("\n")
    .find((entry) => entry.startsWith(`${SLUG}/send_postcard`))
  expect(line, toolText(search)).toContain("Posts a physical greeting card")

  const scoped = await callTool(baseURL!, token, "search_tools", {
    query: "numbers",
    server: SLUG,
  })
  expect(toolText(scoped)).toContain(`${SLUG}/add_numbers`)

  const described = await callTool(baseURL!, token, "describe_tool", {
    server: SLUG,
    tool: "add_numbers",
  })
  const description = JSON.parse(toolText(described)) as {
    inputSchema: { properties: Record<string, unknown> }
    annotations?: { readOnlyHint?: boolean }
  }
  expect(Object.keys(description.inputSchema.properties)).toEqual(["a", "b"])
  expect(description.annotations?.readOnlyHint).toBe(true)

  const sum = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "add_numbers",
    arguments: { a: 19, b: 23 },
  })
  expect(sum.body.result?.isError ?? false, toolText(sum)).toBe(false)
  expect(toolText(sum)).toBe("42")

  // The upstream saw the stored secret; the assistant only sees the result.
  const echoed = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "echo_auth",
    arguments: {},
  })
  expect(toolText(echoed)).toBe(`Bearer ${upstream.expectedToken}`)
  expect(upstream.calls.at(-1)?.authorization).toBe(
    `Bearer ${upstream.expectedToken}`,
  )

  const unknown = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "no_such_tool",
    arguments: {},
  })
  expect(unknown.body.result?.isError).toBe(true)
  expect(toolText(unknown)).toContain("no tool called no_such_tool")
})

test("picks up tools the server adds later", async ({ page, baseURL }) => {
  // An assistant asking for a tool PCP has not seen yet makes it read the
  // server's list again, and finds it.
  upstream.lateTools.add("water_plants")
  const described = await callTool(baseURL!, token, "describe_tool", {
    server: SLUG,
    tool: "water_plants",
  })
  expect(described.body.result?.isError ?? false, toolText(described)).toBe(
    false,
  )
  // New tools ask the owner first, whatever the token's other tools do.
  expect(JSON.parse(toolText(described))).toMatchObject({
    tool: "water_plants",
    access: "ask",
  })

  // The owner reads it again from the token's page, to decide a new tool
  // before an assistant asks for it.
  upstream.lateTools.add("feed_the_cat")
  await openToken(page, `Assistant ${RUN}`)
  await showTools(page, SLUG)
  const newTool = page.getByLabel(`Access to ${SLUG}/feed_the_cat`)
  await expect(page.getByLabel(`Access to ${SLUG}/water_plants`)).toBeVisible()
  await expect(newTool).toHaveCount(0)
  await page
    .getByRole("button", { name: `Refresh tools on ${SLUG}`, exact: true })
    .click()
  await expect(page.getByText("Found 5 tools.")).toBeVisible()
  await expect(newTool).toHaveValue("ask")
})

test("a token scoped to other servers cannot see this one", async ({
  page,
  baseURL,
}) => {
  // Another server, only so the scoped token has something to be scoped to.
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(`Other ${RUN}`)
  await page.getByLabel("Server URL").fill(`${upstream.origin}/nowhere`)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)

  await page.goto("/tokens")
  await page.getByLabel("Name").fill(`Scoped ${RUN}`)
  await page.getByLabel("Only these servers").check()
  await page.getByLabel(`Other ${RUN}`).check()
  await page.getByRole("button", { name: "Create token" }).click()
  await confirmWithPassword(page, OWNER_PASSWORD)
  const scopedToken = (await page.getByTestId("new-token").textContent())!

  const { instructions } = await initialize(baseURL!, scopedToken)
  expect(instructions).not.toContain(SLUG)

  const call = await callTool(baseURL!, scopedToken, "call_tool", {
    server: SLUG,
    tool: "add_numbers",
    arguments: { a: 1, b: 1 },
  })
  expect(call.body.result?.isError).toBe(true)
  expect(toolText(call)).toContain(`No server called ${SLUG}`)
})

test("revoking the token locks the gateway", async ({ page, baseURL }) => {
  await page.goto("/tokens")
  const row = page.getByRole("listitem").filter({ hasText: `Assistant ${RUN}` })
  page.once("dialog", (dialog) => dialog.accept())
  await row.getByRole("button", { name: "Revoke" }).click()
  await expect(row.getByText("Revoked")).toBeVisible()

  const response = await mcpRequest(baseURL!, token, "tools/list")
  expect(response.status).toBe(401)
})
