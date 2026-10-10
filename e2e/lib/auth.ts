import { expect, type Page } from "@playwright/test"

// Fixed on purpose: the same password every run keeps the suite idempotent
// against a database that was not reset (see e2e/README.md).
export const OWNER_NAME = "Ada"
export const OWNER_PASSWORD = "e2e-owner-password-1!"

/** Enters the password on /login and waits for the dashboard. */
export async function unlock(page: Page, password = OWNER_PASSWORD) {
  await page.goto("/login")
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Unlock" }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible({
    timeout: 30_000,
  })
}
