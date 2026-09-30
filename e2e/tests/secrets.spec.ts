import { expect, test } from "@playwright/test"

import { addSecret } from "../lib/ui"

// The secret store from the owner's side: add, reveal, rotate, delete.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `Postcard key ${RUN}`

test("adds a secret and reveals it", async ({ page }) => {
  await addSecret(page, {
    name: NAME,
    value: "pk_live_hunter2",
    description: "For the postcard service",
  })

  const row = page.getByRole("listitem").filter({ hasText: NAME })
  await expect(row.getByText("For the postcard service")).toBeVisible()
  // The value is not on the page until asked for.
  await expect(page.getByText("pk_live_hunter2")).toHaveCount(0)

  await row.getByRole("button", { name: "Reveal" }).click()
  await expect(row.getByText("pk_live_hunter2")).toBeVisible()
  await row.getByRole("button", { name: "Hide" }).click()
  await expect(row.getByText("pk_live_hunter2")).toHaveCount(0)
})

test("refuses a duplicate name", async ({ page }) => {
  await page.goto("/secrets")
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Value").fill("another")
  await page.getByRole("button", { name: "Save secret" }).click()
  await expect(page.locator("p[role=alert]")).toHaveText(/already exists/)
})

test("rotates the value and renames it", async ({ page }) => {
  await page.goto("/secrets")
  const row = page.getByRole("listitem").filter({ hasText: NAME })
  await row.getByRole("button", { name: "Edit" }).click()
  await row.getByLabel("Name").fill(`${NAME} v2`)
  await row.getByLabel("New value").fill("pk_live_rotated")
  await row.getByRole("button", { name: "Save" }).click()

  const renamed = page.getByRole("listitem").filter({ hasText: `${NAME} v2` })
  await expect(renamed).toBeVisible()
  await renamed.getByRole("button", { name: "Reveal" }).click()
  await expect(renamed.getByText("pk_live_rotated")).toBeVisible()
})

test("deletes it", async ({ page }) => {
  await page.goto("/secrets")
  const row = page.getByRole("listitem").filter({ hasText: `${NAME} v2` })
  page.once("dialog", (dialog) => dialog.accept())
  await row.getByRole("button", { name: "Delete" }).click()
  await expect(row).toHaveCount(0)
})
