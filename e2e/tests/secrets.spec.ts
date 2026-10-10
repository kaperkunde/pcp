import { expect, test } from "@playwright/test"

import { acceptNextDialog, addSecret } from "../lib/ui"

// The secret store from the owner's side: a value is hidden until the owner
// asks for it, and the secret can be renamed, rotated and deleted.
const RUN = Date.now().toString(36)
const NAME = `Postcard key ${RUN}`

test("a secret is hidden until revealed, refuses a duplicate name, and can be rotated, renamed and deleted", async ({
  page,
}) => {
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

  // A second secret under the same name is refused, and the sheet stays open.
  await page.getByRole("button", { name: "Add a secret" }).click()
  const dialog = page.getByRole("dialog", { name: "Add a secret" })
  await dialog.getByLabel("Name", { exact: true }).fill(NAME)
  await dialog.getByLabel("Value").fill("another")
  await dialog.getByRole("button", { name: "Save secret" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(/already exists/)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()

  await row.getByRole("button", { name: "Edit" }).click()
  await row.getByLabel("Name", { exact: true }).fill(`${NAME} v2`)
  await row.getByLabel("New value").fill("pk_live_rotated")
  await row.getByRole("button", { name: "Save" }).click()

  const renamed = page.getByRole("listitem").filter({ hasText: `${NAME} v2` })
  await expect(renamed).toBeVisible()
  await renamed.getByRole("button", { name: "Reveal" }).click()
  await expect(renamed.getByText("pk_live_rotated")).toBeVisible()

  acceptNextDialog(page)
  await renamed.getByRole("button", { name: "Delete" }).click()
  await expect(renamed).toHaveCount(0)
})
