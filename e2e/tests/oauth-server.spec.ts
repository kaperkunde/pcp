import { createHash, randomBytes } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { OWNER_PASSWORD } from "../lib/auth"
import { initialize, mcpRequest } from "../lib/mcp"
import { confirmWithPassword } from "../lib/ui"

// PCP as an authorization server: what claude.ai's custom connectors and
// ChatGPT do with nothing but https://<pcp>/mcp. The client finds PCP's
// sign-in from the 401, registers itself, sends the owner to PCP's page,
// trades the code for tokens, and uses /mcp with a token of its own that the
// owner sees, and revokes, under API tokens.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const CLIENT_NAME = `Connector ${RUN}`
const TOKEN_NAME = `Signed in ${RUN}`
// Nothing listens here: the browser's visit is caught and its query read.
const REDIRECT = "http://127.0.0.1:9/callback"

type Discovery = { issuer: string; resource: string }
type Tokens = { access_token: string; refresh_token: string }

let discovery: Discovery
let clientId: string
let tokens: Tokens

function pkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function authorizePath(
  challenge: string,
  state: string,
  extra: Record<string, string> = {},
) {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: discovery.resource,
    ...extra,
  })}`
}

/** Catches the browser's return to the client; resolves with its query. */
function catchCallback(page: Page): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    void page.route("http://127.0.0.1:9/**", async (route) => {
      resolve(new URL(route.request().url()).searchParams)
      await route.fulfill({
        contentType: "text/plain",
        body: "Back at the app",
      })
    })
  })
}

async function token(baseURL: string, params: Record<string, string>) {
  const response = await fetch(`${baseURL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  })
  return { status: response.status, body: await response.json() }
}

test("a 401 from /mcp leads to PCP's own authorization server", async ({
  baseURL,
}) => {
  const response = await mcpRequest(baseURL!, null, "tools/list")
  expect(response.status).toBe(401)

  const metadataUrl = response.wwwAuthenticate?.match(
    /resource_metadata="([^"]+)"/,
  )?.[1]
  expect(metadataUrl).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/)

  const resource = await (
    await fetch(`${baseURL}/.well-known/oauth-protected-resource/mcp`)
  ).json()
  expect(resource.resource).toMatch(/\/mcp$/)
  expect(resource.authorization_servers).toHaveLength(1)

  const server = await (
    await fetch(`${baseURL}/.well-known/oauth-authorization-server`)
  ).json()
  expect(server).toMatchObject({
    issuer: resource.authorization_servers[0],
    authorization_endpoint: `${resource.authorization_servers[0]}/oauth/authorize`,
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  })

  discovery = { issuer: server.issuer, resource: resource.resource }
})

test("a client registers itself", async ({ baseURL }) => {
  const response = await fetch(`${baseURL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  })
  expect(response.status).toBe(201)
  const client = await response.json()
  expect(client.client_secret).toBeUndefined()
  clientId = client.client_id
})

test("the owner signs in, allows it, and the assistant gets a token of its own", async ({
  browser,
  baseURL,
}) => {
  // Not signed in yet, as when the assistant's link opens a fresh browser.
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.201" },
  })
  const page = await context.newPage()
  const { verifier, challenge } = pkce()
  const callback = catchCallback(page)

  await page.goto(authorizePath(challenge, `state-${RUN}`))
  await expect(page).toHaveURL(/\/login\?next=/)
  await page.getByLabel("Password").fill(OWNER_PASSWORD)
  await page.getByRole("button", { name: "Unlock" }).click()

  await expect(
    page.getByRole("heading", { name: `Connect ${CLIENT_NAME}?` }),
  ).toBeVisible()
  await expect(page.getByText("registered itself with PCP")).toBeVisible()
  await expect(page.getByText("127.0.0.1:9", { exact: true })).toBeVisible()
  await page.getByLabel("Token name").fill(TOKEN_NAME)
  await page.getByText("More options").click()
  await page
    .getByLabel("Let an assistant with this token keep memories")
    .check()
  await page.getByRole("button", { name: "Allow" }).click()
  await confirmWithPassword(page, OWNER_PASSWORD)

  const answer = await callback
  expect(answer.get("state")).toBe(`state-${RUN}`)
  expect(answer.get("iss")).toBe(discovery.issuer)
  await context.close()

  const exchanged = await token(baseURL!, {
    grant_type: "authorization_code",
    code: answer.get("code")!,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    resource: discovery.resource,
  })
  expect(exchanged.status).toBe(200)
  expect(exchanged.body).toMatchObject({
    token_type: "Bearer",
    expires_in: 3600,
  })
  tokens = exchanged.body

  const { tools, instructions } = await initialize(
    baseURL!,
    tokens.access_token,
  )
  expect(tools).toEqual(expect.arrayContaining(["search_tools", "memory"]))
  expect(instructions).toContain("PCP")

  // Refresh tokens rotate.
  const refreshed = await token(baseURL!, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  })
  expect(refreshed.status).toBe(200)
  expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token)

  const listed = await mcpRequest(
    baseURL!,
    refreshed.body.access_token,
    "tools/list",
  )
  expect(listed.status).toBe(200)
  tokens = refreshed.body
})

test("the owner sees the token under API tokens, and revoking it signs the assistant out", async ({
  page,
  baseURL,
}) => {
  await page.goto("/tokens")
  const row = page.getByRole("listitem").filter({ hasText: TOKEN_NAME })
  await expect(row.getByText(`signed in from ${CLIENT_NAME}`)).toBeVisible()

  await row.getByRole("link").first().click()
  await expect(
    page.getByRole("heading", { name: TOKEN_NAME, level: 1 }),
  ).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Revoke access" }).click()
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible()

  const response = await mcpRequest(baseURL!, tokens.access_token, "tools/list")
  expect(response.status).toBe(401)
  expect(response.wwwAuthenticate).toContain('error="invalid_token"')

  const refreshed = await token(baseURL!, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  })
  expect(refreshed.body.error).toBe("invalid_grant")
})

test("denying sends the assistant away with nothing", async ({ page }) => {
  const callback = catchCallback(page)

  await page.goto(authorizePath(pkce().challenge, `deny-${RUN}`))
  await page.getByRole("button", { name: "Deny" }).click()

  const answer = await callback
  expect(answer.get("error")).toBe("access_denied")
  expect(answer.get("state")).toBe(`deny-${RUN}`)
  expect(answer.get("code")).toBeNull()
})
