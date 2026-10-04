import { readFileSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { OWNER_NAME, OWNER_PASSWORD, unlock } from "../lib/auth"
import { mcpRequest } from "../lib/mcp"
import { addSecret, createToken } from "../lib/ui"

// Export and restore from Settings: the export asks for the owner's
// password and downloads a file that holds no plain secret; restoring it
// shows what it holds, asks again, and puts everything back as it was,
// undoing what came after. The export is this PCP's own, so the password
// and the recovery key saved by `setup` stay what they are and the suite
// stays re-runnable. Signs every browser out, so it runs last and signs in
// on its own.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const EXPORT_PASSWORD = "e2e-export-password-9!"
const EXPORT_FILE = path.join(__dirname, "..", ".state", "backup.pcpexport")

let keptToken: string
let laterToken: string

function card(page: Page, title: string) {
  return page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  })
}

test("exports everything to a file, after asking for the password", async ({
  page,
}) => {
  await unlock(page)
  await addSecret(page, { name: `Kept ${RUN}`, value: `kept-value-${RUN}` })
  keptToken = await createToken(page, `Before export ${RUN}`)

  await page.goto("/settings")
  const exportCard = card(page, "Export")
  await exportCard
    .getByLabel("Export password", { exact: true })
    .fill(EXPORT_PASSWORD)
  await exportCard.getByLabel("Repeat export password").fill("something else")
  await exportCard.getByRole("button", { name: "Continue" }).click()
  await expect(exportCard.locator("p[role=alert]")).toHaveText(/do not match/)

  await exportCard.getByLabel("Repeat export password").fill(EXPORT_PASSWORD)
  await exportCard.getByRole("button", { name: "Continue" }).click()

  // The form that asks for the password holds the account and the password
  // and nothing else a password manager would fill (see e2e/lib/ui.ts).
  const password = exportCard.getByLabel("Your password")
  await expect(password).toHaveAttribute("autocomplete", "current-password")
  await password.fill("not the password")
  await exportCard.getByRole("button", { name: "Confirm" }).click()
  await expect(exportCard.locator("p[role=alert]")).toHaveText(/not right/)

  await password.fill(OWNER_PASSWORD)
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportCard.getByRole("button", { name: "Confirm" }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(
    /^pcp-export-\d{4}-\d{2}-\d{2}\.pcpexport$/,
  )
  await download.saveAs(EXPORT_FILE)
  await expect(exportCard.getByRole("status")).toHaveText(
    /Downloaded pcp-export-.*Keep it with your backups/,
  )

  // An envelope around ciphertext: nothing of the vault is readable in it.
  const text = readFileSync(EXPORT_FILE, "utf8")
  expect(text).toContain('"format":"pcp-export"')
  expect(text).not.toContain(`kept-value-${RUN}`)
  expect(text).not.toContain(keptToken)
})

test("restores the file, undoing what came after it", async ({
  page,
  baseURL,
}) => {
  await unlock(page)
  await addSecret(page, { name: `Marker ${RUN}`, value: "marker" })
  laterToken = await createToken(page, `After export ${RUN}`)
  expect((await mcpRequest(baseURL!, laterToken, "tools/list")).status).toBe(
    200,
  )

  await page.goto("/settings")
  const restoreCard = card(page, "Restore")
  await restoreCard.getByLabel("Export file").setInputFiles(EXPORT_FILE)
  await restoreCard
    .getByLabel("Export password")
    .fill("not the export password")
  await restoreCard.getByRole("button", { name: "Check the export" }).click()
  await expect(restoreCard.locator("p[role=alert]")).toHaveText(
    /export password/,
  )

  await restoreCard.getByLabel("Export password").fill(EXPORT_PASSWORD)
  await restoreCard.getByRole("button", { name: "Check the export" }).click()

  // What the file holds, and what restoring it does, before anything changes.
  const preview = restoreCard.getByTestId("restore-preview")
  await expect(preview).toContainText(OWNER_NAME)
  await expect(preview).toContainText(/\d+ secrets?/)
  await expect(preview).toContainText(/\d+ API tokens?/)
  await expect(
    restoreCard.getByText(/Everything in this PCP is replaced/),
  ).toBeVisible()
  await expect(
    page.getByRole("listitem").filter({ hasText: `Marker ${RUN}` }),
  ).toHaveCount(0)

  await restoreCard
    .getByLabel("Replace everything in this PCP with the export")
    .check()
  await restoreCard.getByLabel("Your password").fill("not the password")
  await restoreCard.getByRole("button", { name: "Replace everything" }).click()
  await expect(restoreCard.locator("p[role=alert]")).toHaveText(/not right/)
  // A refused password does not throw the preview away.
  await expect(preview).toBeVisible()

  await restoreCard.getByLabel("Your password").fill(OWNER_PASSWORD)
  await restoreCard.getByRole("button", { name: "Replace everything" }).click()

  // The owner's own export: the same password opens it, so they stay in.
  await expect(page).toHaveURL(/\/settings\?restored=1$/)
  await expect(
    page.getByRole("status").filter({ hasText: "Restored from the export." }),
  ).toBeVisible()

  await page.goto("/secrets")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: `Kept ${RUN}` })
      .first(),
  ).toBeVisible()
  await expect(
    page.getByRole("listitem").filter({ hasText: `Marker ${RUN}` }),
  ).toHaveCount(0)

  // The exported token works; the one made after the export is gone.
  expect((await mcpRequest(baseURL!, keptToken, "tools/list")).status).toBe(200)
  expect((await mcpRequest(baseURL!, laterToken, "tools/list")).status).toBe(
    401,
  )
})

test("locks and unlocks with the same password afterwards", async ({
  page,
}) => {
  await unlock(page)
  await page.getByRole("button", { name: "Lock" }).click()
  await expect(page).toHaveURL(/\/login$/)
  await unlock(page)

  // Set up means set up: the restore page for a fresh PCP is gone.
  await page.goto("/setup/restore")
  await expect(page).toHaveURL(/\/settings$/)
})
