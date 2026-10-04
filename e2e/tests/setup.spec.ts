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

    // Then the optional step for reaching PCP from outside, skipped here
    // (the network project walks it).
    await page.getByRole("link", { name: "I have saved it — continue" }).click()
    await expect(
      page.getByRole("heading", { name: "Reach PCP from anywhere (optional)" }),
    ).toBeVisible()
    await expect(page.getByRole("form", { name: "Dynamic DNS" })).toBeVisible()
    await page.getByRole("link", { name: "Skip for now — open PCP" }).click()
    await expect(page.getByRole("tab", { name: "Servers" })).toBeVisible()
  }

  // Setup is one-shot: the signed-in owner is told so, and (below, once
  // locked) a stranger is sent to sign in.
  await page.goto("/setup")
  await expect(
    page.getByRole("heading", { name: "PCP is already set up" }),
  ).toBeVisible()
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
})

// Each project that starts signed in gets a session of its own, as if it
// were another browser: typing the password again (to make a token) is
// limited per session, and the suite in one session runs out. Signing in is
// limited per address, so each signs in from an address of its own.
test("signs each project in with a session of its own", async ({
  browser,
  baseURL,
}) => {
  const projects = test
    .info()
    .config.projects.filter(
      (project) => typeof project.use.storageState === "string",
    )
  expect(projects.length).toBeGreaterThan(0)

  for (const [index, project] of projects.entries()) {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${index + 1}` },
    })
    await unlock(await context.newPage())
    await context.storageState({ path: project.use.storageState as string })
    await context.close()
  }
})

// A PCP at a home address (localhost here) is one an assistant running
// elsewhere cannot reach; Settings explains a tunnel and the router until a
// public address is set. Against a deployed PCP (PCP_URL) there is nothing to
// explain. Signs in from an address of its own, like the sessions above.
test("Settings explains how to reach a PCP at home from outside", async ({
  browser,
  baseURL,
}) => {
  const host = new URL(baseURL!).hostname
  test.skip(
    !["localhost", "127.0.0.1", "[::1]"].includes(host),
    "PCP is not at a local address",
  )

  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.200" },
  })
  const page = await context.newPage()
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

  // The router steps are folded away until asked for. They lead to the
  // Dynamic DNS and HTTPS cards; outside the desktop app there is no menu
  // to mention.
  await card.getByText("Through your router").click()
  await expect(card.getByText(/Forward ports 80 and 443/)).toBeVisible()
  await expect(
    card.getByText("Accept connections from other devices"),
  ).toHaveCount(0)

  await context.close()
})
