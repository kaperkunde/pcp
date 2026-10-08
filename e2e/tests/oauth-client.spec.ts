import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"

// An OAuth server that lets no app register itself, the way most large
// providers work: the add form shows the redirect URI to register, and the
// client the owner created there (its secret pasted in and kept as one of
// the owner's secrets) connects it.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SERVER_NAME = `Closed postcards ${RUN}`

let upstream: Upstream

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("with the owner's own client it connects", async ({ page }) => {
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.closedMcpUrl)
  await page.getByLabel("Authentication").selectOption("oauth")

  // The redirect URI is shown before the server exists, to register first.
  const redirectUri = (await page
    .getByTestId("oauth-redirect-url")
    .textContent())!
  expect(redirectUri).toMatch(/^https?:\/\/[^/]+\/api\/oauth\/callback$/)

  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  const serverId = page.url().split("/").pop()!

  // What the owner does in the provider's console.
  upstream.closedClient.redirectUris.add(redirectUri)

  // Connecting finds out the server needs a client from the owner, and
  // asks for it on the page Connect left them on.
  await page.getByRole("link", { name: "Connect", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/servers/${serverId}$`))
  expect(upstream.closedSignIns).toHaveLength(0)
  await page
    .getByLabel("Client ID", { exact: true })
    .fill(upstream.closedClient.id)
  await page
    .getByLabel("Client secret", { exact: true })
    .fill(upstream.closedClient.secret)
  await page.getByRole("button", { name: "Save client" }).click()
  await expect(page.getByRole("button", { name: "Save client" })).toHaveCount(0)

  await page.getByRole("link", { name: "Connect", exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`/servers/${serverId}\\?connected=1$`),
  )
  expect(upstream.closedSignIns.at(-1)).toMatchObject({
    client_id: upstream.closedClient.id,
    redirect_uri: redirectUri,
  })

  // The secret the owner pasted is one of their own, by the server's name.
  await page.goto("/secrets")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: `${SERVER_NAME} OAuth client secret` }),
  ).toBeVisible()
})
