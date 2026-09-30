import { expect, test } from "@playwright/test"

import { OWNER_PASSWORD, unlock } from "../lib/auth"
import { loadState, type SetupState } from "../lib/state"

// Losing the password: the recovery key from setup sets a new one, every
// browser is signed out, and the vault's contents are intact. Ends by
// putting the original password back so the suite stays re-runnable.
test.describe.configure({ mode: "serial" })

const TEMPORARY_PASSWORD = "e2e-temporary-password-2!"

test("resets the password with the recovery key", async ({ page }) => {
  const { recoveryKey } = loadState<SetupState>("setup")

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
  await page.getByRole("button", { name: "Set the new password" }).click()
  await expect(page.getByRole("tab", { name: "Servers" })).toBeVisible()

  // Everything is still there: the key never changed, only its wrapping.
  await page.goto("/secrets")
  await expect(
    page.getByRole("heading", { name: "Secrets", exact: true }),
  ).toBeVisible()
})

test("the old password no longer works and the new one does", async ({
  page,
}) => {
  await page.goto("/login")
  await page.getByLabel("Password").fill(OWNER_PASSWORD)
  await page.getByRole("button", { name: "Unlock" }).click()
  await expect(page.locator("p[role=alert]")).toHaveText(/not right/)

  await unlock(page, TEMPORARY_PASSWORD)

  // Put the original back through Settings.
  await page.goto("/settings")
  await page.getByLabel("Current password").fill(TEMPORARY_PASSWORD)
  await page.getByLabel("New password", { exact: true }).fill(OWNER_PASSWORD)
  await page.getByLabel("Repeat new password").fill(OWNER_PASSWORD)
  await page.getByRole("button", { name: "Change password" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Password changed." }),
  ).toBeVisible()
})
