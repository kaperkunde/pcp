import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { allowAllTools, createToken } from "../lib/ui"

// An API that signs in with OAuth, like Gmail's REST API: its OpenAPI
// document declares the flow, the provider lets no app register itself, so
// an assistant proposes it with the owner's client ID and the owner types
// the client secret in on the approval page. Then the owner connects it, and
// the assistant's calls carry the token PCP got, which it renews itself.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `OAuth endpoint assistant ${RUN}`
const NAME = `Whoami ${RUN}`

let upstream: Upstream
let token: string
let redirectUri: string
let endpointId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("an assistant proposes it with the owner's client, and the owner enters the secret on PCP's page", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)

  const asked = await callTool(baseURL!, token, "register_server", {
    name: NAME,
    // As text: PCP downloads an assistant's openapi_url from public
    // addresses only, and the fake provider is on loopback.
    openapi_schema: await (await fetch(upstream.closedApiSpecUrl)).text(),
    url: upstream.closedApiUrl,
    auth_type: "oauth",
    client_id: upstream.closedClient.id,
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  expect(toolText(asked)).toContain("Not done yet")
  expect(toolText(asked)).toMatch(
    /type the client secret of their OAuth client in there/,
  )
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()

  // Where the owner will sign in and where the client secret goes, both
  // from the schema, and what to set up with the provider.
  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Add the API endpoint ${NAME}?`)).toBeVisible()
  await expect(
    page.getByText(`Sign-in at: ${upstream.origin}/closed/authorize`),
  ).toBeVisible()
  await expect(
    page.getByText(
      `Tokens from: ${upstream.origin}/closed/token; your client secret goes there`,
    ),
  ).toBeVisible()
  await expect(
    page.getByText(/Authentication: OAuth with your client "closed-client"/),
  ).toBeVisible()
  const shown = await page
    .getByText(/^Redirect URI your client needs: /)
    .textContent()
  redirectUri = shown!.replace("Redirect URI your client needs: ", "").trim()
  expect(redirectUri).toMatch(/^https?:\/\/[^/]+\/api\/oauth\/callback$/)

  // What the owner does in the provider's console.
  upstream.closedClient.redirectUris.add(redirectUri)

  await page
    .getByLabel(
      `Client secret of the OAuth client "${upstream.closedClient.id}"`,
    )
    .fill(upstream.closedClient.secret)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${NAME}`,
  )
})

test("the owner connects it, and fixes a sign-in PCP cannot renew in place", async ({
  page,
}) => {
  await page.goto("/servers")
  await page.getByRole("link").filter({ hasText: NAME }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  endpointId = page.url().split("/").pop()!
  await expect(page.getByText("Needs connecting")).toBeVisible()

  // An assistant's endpoint reaches public addresses only, and the fake
  // provider is on loopback.
  await page.getByLabel("Public addresses only").uncheck()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  await page.getByRole("link", { name: "Connect", exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`/servers/${endpointId}\\?connected=1$`),
  )
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  expect(upstream.closedSignIns.at(-1)).toMatchObject({
    client_id: upstream.closedClient.id,
    redirect_uri: redirectUri,
    scope: "whoami.read",
  })
  // A REST API names no resource indicator.
  expect(upstream.closedSignIns.at(-1)).not.toHaveProperty("resource")

  // This provider gives a refresh token only when asked: the page says so
  // and asks for the parameters right there.
  await expect(page.getByText(/and PCP cannot renew it/)).toBeVisible()
  const signIns = upstream.closedSignIns.length
  await page
    .getByLabel("Extra sign-in parameters", { exact: true })
    .fill("access_type=offline&prompt=consent")
  await page.getByRole("button", { name: "Save and reconnect" }).click()
  // The page is on ?connected=1 already: wait for the second sign-in.
  await expect.poll(() => upstream.closedSignIns.length).toBe(signIns + 1)
  await page.waitForLoadState()
  await expect(page).toHaveURL(
    new RegExp(`/servers/${endpointId}\\?connected=1$`),
  )
  expect(upstream.closedSignIns.at(-1)).toMatchObject({
    access_type: "offline",
    prompt: "consent",
  })
  await expect(page.getByText(/and PCP cannot renew it/)).toHaveCount(0)
})

test("the assistant's calls carry the token, which it never sees", async ({
  page,
  baseURL,
}) => {
  await page.goto(`/servers/${endpointId}`)
  const slug = await page.getByLabel("Short name").inputValue()
  await allowAllTools(page, TOKEN_NAME, slug)

  const result = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "whoami",
    arguments: {},
  })
  expect(result.body.result?.isError ?? false, toolText(result)).toBe(false)
  expect(toolText(result)).toContain("the owner")

  const sent = upstream.closedApiRequests.at(-1)!
  expect(sent.path).toBe("/closed-api/whoami")
  const bearer = sent.authorization?.replace(/^Bearer /, "") ?? ""
  expect(upstream.issuedTokens.has(bearer)).toBe(true)
  expect(toolText(result)).not.toContain(bearer)
})
