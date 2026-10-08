import { expect, test } from "@playwright/test"

import { OWNER_PASSWORD, unlock } from "../lib/auth"
import { mcpRequest } from "../lib/mcp"
import { loadState, saveState, type SetupState } from "../lib/state"
import { addSecret, createToken, openSettingsRow } from "../lib/ui"

// Losing the password: the recovery key from setup sets a new one, every
// browser is signed out (and, when asked, every API token revoked), and the
// vault's contents are intact. Then the ways to end someone else's access:
// a new recovery key, which takes the password, and signing out
// everywhere. Puts the original password back and saves the new recovery
// key so the suite stays re-runnable.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TEMPORARY_PASSWORD = "e2e-temporary-password-2!"

test("resets the password with the recovery key", async ({ page, baseURL }) => {
  const { recoveryKey } = loadState<SetupState>("setup")
  const secret = `recovery-${RUN}`

  // A token and a secret made before recovery: the token is to see revoked,
  // the secret to see survive.
  await unlock(page)
  const token = await createToken(page, `Before recovery ${RUN}`)
  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(200)
  await addSecret(page, { name: secret, value: "kept through recovery" })

  await page.goto("/recover")
  await page.getByLabel("Recovery key").fill("pcp_recovery_wrong")
  await page
    .getByLabel("New password", { exact: true })
    .fill(TEMPORARY_PASSWORD)
  await page.getByLabel("Repeat new password").fill(TEMPORARY_PASSWORD)
  await page.getByRole("button", { name: "Set the new password" }).click()
  await expect(page.locator("p[role=alert]")).toHaveText(/recovery key/)

  // A submitted form is reset by React; fill every field again.
  await page.getByLabel("Recovery key").fill(recoveryKey)
  await page
    .getByLabel("New password", { exact: true })
    .fill(TEMPORARY_PASSWORD)
  await page.getByLabel("Repeat new password").fill(TEMPORARY_PASSWORD)
  await page.getByLabel("Also revoke every API token").check()
  await page.getByRole("button", { name: "Set the new password" }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible()

  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(401)

  // Everything is still there: the key never changed, only its wrapping.
  await page.goto("/secrets")
  await expect(
    page.getByRole("listitem").filter({ hasText: secret }).first(),
  ).toBeVisible()

  // The old password no longer works and the new one does.
  await page.context().clearCookies()
  await page.goto("/login")
  await page.getByLabel("Password").fill(OWNER_PASSWORD)
  await page.getByRole("button", { name: "Unlock" }).click()
  await expect(page.locator("p[role=alert]")).toHaveText(/not right/)

  await unlock(page, TEMPORARY_PASSWORD)

  // Put the original back through Settings.
  await page.goto("/settings")
  const password = await openSettingsRow(page, "Password")
  await password.getByLabel("Current password").fill(TEMPORARY_PASSWORD)
  await password
    .getByLabel("New password", { exact: true })
    .fill(OWNER_PASSWORD)
  await password.getByLabel("Repeat new password").fill(OWNER_PASSWORD)
  await password.getByRole("button", { name: "Change password" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Password changed." }),
  ).toBeVisible()
})

test("a new recovery key takes the password", async ({ page }) => {
  const setup = loadState<SetupState>("setup")
  await unlock(page)
  await page.goto("/settings")

  const card = await openSettingsRow(page, "Recovery key")
  await card.getByLabel("Your password").fill("not the password")
  page.once("dialog", (dialog) => dialog.accept())
  await card.getByRole("button", { name: "Replace the recovery key" }).click()
  await expect(card.locator("p[role=alert]")).toHaveText(/not right/)
  await expect(card.getByTestId("recovery-key")).toHaveCount(0)

  await card.getByLabel("Your password").fill(OWNER_PASSWORD)
  page.once("dialog", (dialog) => dialog.accept())
  await card.getByRole("button", { name: "Replace the recovery key" }).click()
  const fresh = await card.getByTestId("recovery-key").textContent()
  expect(fresh).toMatch(/^pcp_recovery_/)
  expect(fresh).not.toBe(setup.recoveryKey)
  // The next run recovers with this one.
  saveState("setup", { ...setup, recoveryKey: fresh! } satisfies SetupState)
})

test("signing out everywhere can revoke every API token", async ({
  page,
  baseURL,
}) => {
  await unlock(page)
  const token = await createToken(page, `Before signing out ${RUN}`)
  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(200)

  await page.goto("/settings")
  await openSettingsRow(page, "Signed-in devices")
  await page.getByLabel("Also revoke every API token").check()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Sign out everywhere" }).click()
  await expect(page).toHaveURL(/\/login$/)

  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(401)
})
