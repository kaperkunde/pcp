import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { E2E_EDGE_HTTP_PORT } from "../lib/network"

// Dynamic DNS and HTTPS from Settings. The dynamic DNS service is the fake
// upstream's update URL; Let's Encrypt is an address where nothing answers
// (PCP_ACME_DIRECTORY in playwright.config.ts), so asking for a certificate
// fails the way it does when port 80 is not reachable, and the page says so.
test.describe.configure({ mode: "serial" })

const NAME = `pcp-${Date.now().toString(36)}.e2e.example`
let upstream: Upstream

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream.close()
})

function ddnsForm(page: import("@playwright/test").Page) {
  return page.getByRole("form", { name: "Dynamic DNS" })
}

test("turns dynamic DNS on with an update URL and sends the first update", async ({
  page,
}) => {
  await page.goto("/settings")
  const form = ddnsForm(page)
  await form.getByLabel("Service").selectOption("custom")

  // A login in the address goes to the service as a header.
  const address = upstream.ddns.updateUrl.replace(
    "http://",
    "http://me:hunter2@",
  )
  await form.getByLabel("Update address").fill(`${address}?host={hostname}`)
  await form.getByLabel("The name it updates (optional)").fill(NAME)
  await form.getByRole("button", { name: "Turn on dynamic DNS" }).click()

  await expect(form.getByRole("status")).toHaveText(
    `Saved. ${NAME} was updated.`,
  )
  expect(upstream.ddns.updates).toHaveLength(1)
  expect(upstream.ddns.updates[0]).toEqual({
    query: { host: NAME },
    authorization: `Basic ${Buffer.from("me:hunter2").toString("base64")}`,
  })

  const status = page.getByTestId("ddns-status")
  await expect(status.getByText("Working")).toBeVisible()
  // The address (with its login) is never shown back.
  await expect(page.getByText("hunter2")).toHaveCount(0)
  await expect(
    page.getByText(`Saved: an address on ${new URL(upstream.origin).host}.`),
  ).toBeVisible()
})

test("stops when the service refuses the login, until the settings are saved", async ({
  page,
}) => {
  upstream.ddns.status = 403
  await page.goto("/settings")
  await page.getByRole("button", { name: "Update now" }).click()

  const status = page.getByTestId("ddns-status")
  await expect(status.getByText("Stopped")).toBeVisible()
  await expect(status.getByRole("alert")).toContainText(
    "PCP will not try again until you save the settings",
  )
  expect(upstream.ddns.updates).toHaveLength(2)

  // Saving again (the address left blank keeps it) lifts the stop.
  upstream.ddns.status = 200
  const form = ddnsForm(page)
  await form.getByRole("button", { name: "Save and update" }).click()
  await expect(form.getByRole("status")).toHaveText(
    `Saved. ${NAME} was updated.`,
  )
  await expect(status.getByText("Working")).toBeVisible()
  expect(upstream.ddns.updates).toHaveLength(3)
})

test("turns HTTPS on for the dynamic DNS name and says why there is no certificate", async ({
  page,
  request,
}) => {
  await page.goto("/settings")
  const form = page.getByRole("form", { name: "HTTPS" })
  await expect(
    form.getByLabel(`Use my dynamic DNS name, ${NAME}`),
  ).toBeChecked()
  await form
    .getByLabel("I accept the Let's Encrypt Subscriber Agreement")
    .check()
  await form.getByRole("button", { name: "Turn on HTTPS" }).click()
  await expect(form.getByRole("status")).toContainText(
    `Asking Let's Encrypt for a certificate for ${NAME}`,
  )

  // Port 80 is open: it answers Let's Encrypt and, until there is a
  // certificate, forwards to PCP.
  const edge = `http://127.0.0.1:${E2E_EDGE_HTTP_PORT}`
  await expect
    .poll(async () => (await request.get(`${edge}/api/health`)).status())
    .toBe(200)
  expect(
    (await request.get(`${edge}/.well-known/acme-challenge/none`)).status(),
  ).toBe(404)

  const status = page.getByTestId("https-status")
  await expect(status.getByText("No certificate")).toBeVisible({
    timeout: 30_000,
  })
  await expect(status.getByRole("alert").first()).toContainText(
    `Let's Encrypt did not issue a certificate for ${NAME}`,
  )
  await expect(
    status.getByRole("button", { name: "Try again now" }),
  ).toBeVisible()
})

test("turns HTTPS and dynamic DNS off again", async ({ page, request }) => {
  await page.goto("/settings")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Turn HTTPS off" }).click()
  await expect(
    page.getByRole("button", { name: "Turn on HTTPS" }),
  ).toBeVisible()
  await expect(
    request.get(`http://127.0.0.1:${E2E_EDGE_HTTP_PORT}/api/health`),
  ).rejects.toThrow()

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Turn dynamic DNS off" }).click()
  await expect(
    page.getByRole("button", { name: "Turn on dynamic DNS" }),
  ).toBeVisible()
  await expect(page.getByTestId("ddns-status")).toHaveCount(0)
})
