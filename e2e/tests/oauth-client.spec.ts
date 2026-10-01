import { expect, test, type Page } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { allowAllTools, createToken } from "../lib/ui"

// An OAuth server that lets no app register itself, the way most large
// providers work: PCP says so instead of failing, shows the redirect URI to
// register, takes the client the owner created, and adds the sign-in
// parameters a provider needs before it hands out a refresh token.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SERVER_NAME = `Closed postcards ${RUN}`

let upstream: Upstream
let serverId: string
let redirectUri: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

const settings = (page: Page) =>
  page.locator("form").filter({ has: page.getByLabel("Server URL") })

async function connect(page: Page, name: "Connect" | "Reconnect") {
  await page.goto(`/servers/${serverId}`)
  await page.getByRole("link", { name, exact: true }).click()
}

test("the redirect URI is shown before the server exists", async ({ page }) => {
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.closedMcpUrl)
  await page.getByLabel("Authentication").selectOption("oauth")

  redirectUri = (await page.getByTestId("oauth-redirect-url").textContent())!
  expect(redirectUri).toMatch(/^https?:\/\/[^/]+\/api\/oauth\/callback$/)

  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  serverId = page.url().split("/").pop()!
  await expect(page.getByText("Needs connecting")).toBeVisible()
})

test("connecting says the server needs a client from you", async ({ page }) => {
  await connect(page, "Connect")

  await expect(page).toHaveURL(new RegExp(`/servers/${serverId}\\?error=`))
  await expect(
    page.getByText("Needs an OAuth client", { exact: true }),
  ).toBeVisible()
  // Said once, in the status line, with the address to register.
  await expect(
    page.getByText(/needs an OAuth client from you: it does not let apps/),
  ).toContainText(redirectUri)
  // PCP never got as far as the sign-in page.
  expect(upstream.closedSignIns).toHaveLength(0)
})

test("with the owner's client it connects, and says it cannot renew", async ({
  page,
}) => {
  // What the owner does in the provider's console.
  upstream.closedClient.redirectUris.add(redirectUri)

  await page.goto(`/servers/${serverId}`)
  const form = settings(page)
  await form.getByLabel("Client ID (optional)").fill(upstream.closedClient.id)
  await form
    .getByLabel("New client secret (optional)")
    .fill(upstream.closedClient.secret)
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByText(/^Saved\./)).toBeVisible()
  await expect(page.getByText("Needs connecting")).toBeVisible()

  await connect(page, "Connect")
  await expect(page).toHaveURL(
    new RegExp(`/servers/${serverId}\\?connected=1$`),
  )
  await expect(page.getByText("Tools (3)")).toBeVisible()
  expect(upstream.closedSignIns.at(-1)).toMatchObject({
    client_id: upstream.closedClient.id,
    redirect_uri: redirectUri,
  })
  expect(upstream.closedSignIns.at(-1)).not.toHaveProperty("access_type")
  await expect(
    page.getByText(/did not give PCP a way to renew its access/),
  ).toBeVisible()

  // The secret the owner pasted is one of their own, by the server's name.
  await page.goto("/secrets")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: `${SERVER_NAME} OAuth client secret` }),
  ).toBeVisible()
})

test("extra sign-in parameters get a renewable connection", async ({
  page,
}) => {
  await page.goto(`/servers/${serverId}`)
  const form = settings(page)
  await form
    .getByLabel("Extra sign-in parameters (optional)")
    .fill("client_id=someone-else")
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByText(/PCP sets client_id itself/)).toBeVisible()

  await form
    .getByLabel("Extra sign-in parameters (optional)")
    .fill("access_type=offline&prompt=consent")
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByText(/^Saved\./)).toBeVisible()

  await connect(page, "Reconnect")
  await expect(page).toHaveURL(
    new RegExp(`/servers/${serverId}\\?connected=1$`),
  )
  expect(upstream.closedSignIns.at(-1)).toMatchObject({
    client_id: upstream.closedClient.id,
    access_type: "offline",
    prompt: "consent",
  })
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()
  await expect(
    page.getByText(/did not give PCP a way to renew its access/),
  ).toHaveCount(0)
})

test("the gateway calls the server with the token from that client", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, `Closed assistant ${RUN}`)
  const slug = (await page
    .goto(`/servers/${serverId}`)
    .then(() => page.getByLabel("Short name").inputValue()))!
  await allowAllTools(page, `Closed assistant ${RUN}`, slug)

  const echoed = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "echo_auth",
    arguments: {},
  })
  expect(echoed.body.result?.isError ?? false, toolText(echoed)).toBe(false)
  expect(
    upstream.issuedTokens.has(toolText(echoed).replace("Bearer ", "")),
  ).toBe(true)
})
