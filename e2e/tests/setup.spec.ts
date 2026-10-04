import { expect, test } from "@playwright/test"

import { OWNER_NAME, OWNER_PASSWORD, unlock } from "../lib/auth"
import { saveState, type SetupState } from "../lib/state"

// The first visit to a fresh PCP: setup, the recovery key shown once, then
// locking and unlocking. Idempotent against a database that already has an
// owner: it signs in instead and keeps the recovery key it saved before.
test.describe.configure({ mode: "serial" })

test("sets up the owner on first visit, or signs in", async ({ page }) => {
  await page.goto("/")

  if (page.url().endsWith("/login")) {
    await unlock(page)
  } else {
    await expect(page).toHaveURL(/\/setup$/)
    await expect(
      page.getByRole("heading", { name: "Welcome to PCP" }),
    ).toBeVisible()

    await page.getByLabel("Your name").fill(OWNER_NAME)
    await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD)
    await page.getByLabel("Repeat password").fill(OWNER_PASSWORD)
    await page.getByRole("button", { name: "Create my PCP" }).click()

    await expect(page.getByText("Save your recovery key")).toBeVisible()
    const recoveryKey = await page.getByTestId("recovery-key").textContent()
    expect(recoveryKey).toMatch(/^pcp_recovery_/)
    saveState("setup", {
      name: OWNER_NAME,
      recoveryKey: recoveryKey!,
    } satisfies SetupState)

    await page.getByRole("link", { name: /open PCP/ }).click()
    await expect(page.getByRole("tab", { name: "Servers" })).toBeVisible()
  }

  // Setup is one-shot: the signed-in owner is told so, and (below, once
  // locked) a stranger is sent to sign in.
  await page.goto("/setup")
  await expect(
    page.getByRole("heading", { name: "PCP is already set up" }),
  ).toBeVisible()

  await page.context().storageState({ path: "e2e/.auth/owner.json" })
})

test("locks, refuses a wrong password and unlocks", async ({ page }) => {
  await unlock(page)
  await page.getByRole("button", { name: "Lock" }).click()
  await expect(page).toHaveURL(/\/login$/)

  await page.goto("/setup")
  await expect(page).toHaveURL(/\/login$/)

  // Locked out: the dashboard sends the browser back to sign in.
  await page.goto("/servers")
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel("Password").fill("not the password")
  await page.getByRole("button", { name: "Unlock" }).click()
  await expect(page.locator("p[role=alert]")).toHaveText(/not right/)

  await unlock(page)
  await page.context().storageState({ path: "e2e/.auth/owner.json" })
})

// A PCP at a home address (localhost here) is one an assistant running
// elsewhere cannot reach; Settings explains tunnels and port forwarding until
// a public address is set. Against a deployed PCP (PCP_URL) there is nothing
// to explain.
test("Settings explains how to reach a PCP at home from outside", async ({
  page,
  baseURL,
}) => {
  const host = new URL(baseURL!).hostname
  test.skip(
    !["localhost", "127.0.0.1", "[::1]"].includes(host),
    "PCP is not at a local address",
  )

  await unlock(page)
  await page.goto("/settings")

  const card = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", {
      name: "Reaching PCP from outside your home",
    }),
  })
  await expect(card).toBeVisible()
  await expect(card.getByText("A tunnel: no router changes")).toBeVisible()
  await expect(
    card.getByText(/cloudflared tunnel --url http:\/\/localhost/),
  ).toBeVisible()

  // The router steps are folded away until asked for. Outside the desktop
  // app there is no menu to mention.
  await card.getByText("Port forwarding on your router").click()
  await expect(card.getByText(/The Docker image does/)).toBeVisible()
  await expect(
    card.getByText("Accept connections from other devices"),
  ).toHaveCount(0)
})
