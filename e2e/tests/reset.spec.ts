import { expect, test, type Page } from "@playwright/test"

import { OWNER_NAME, OWNER_PASSWORD, unlock } from "../lib/auth"
import { mcpRequest } from "../lib/mcp"
import { saveState, type SetupState } from "../lib/state"
import { addSecret, createToken } from "../lib/ui"

// Settings → Delete vault: the step opens from a button, asks for the box
// and the owner's password (a wrong one refused, nothing deleted), then
// deletes everything and opens on the setup page. Set up again with the same
// name and password, saving the new recovery key, so the suite stays
// re-runnable. Deletes every session and token, so it runs after everything
// else and signs in on its own.
test.describe.configure({ mode: "serial" })

// Signing in is limited per address, and the projects before this sign in
// from the default one: from an address of its own.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.202" } })

const RUN = Date.now().toString(36)

function card(page: Page, title: string) {
  return page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  })
}

test("deletes the vault after the box and the password, and starts over", async ({
  page,
  baseURL,
}) => {
  await unlock(page)
  await addSecret(page, { name: `Gone ${RUN}`, value: `gone-value-${RUN}` })
  const token = await createToken(page, `Before reset ${RUN}`)
  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(200)

  await page.goto("/settings")
  const deleteCard = card(page, "Delete vault")
  await deleteCard.getByRole("button", { name: "Delete vault…" }).click()
  await expect(deleteCard.getByText(/There is no undo/)).toBeVisible()
  await expect(
    deleteCard.getByText(/This machine's settings stay/),
  ).toBeVisible()

  await deleteCard.getByLabel("Delete everything in this PCP").check()
  await deleteCard.getByLabel("Your password").fill("not the password")
  await deleteCard.getByRole("button", { name: "Delete everything" }).click()
  await expect(deleteCard.locator("p[role=alert]")).toHaveText(/not right/)

  // Refused: nothing went.
  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(200)

  await deleteCard.getByLabel("Your password").fill(OWNER_PASSWORD)
  await deleteCard.getByRole("button", { name: "Delete everything" }).click()

  await expect(page).toHaveURL(/\/setup$/)
  await expect(
    page.getByRole("heading", { name: "Welcome to PCP" }),
  ).toBeVisible()
  expect((await mcpRequest(baseURL!, token, "tools/list")).status).toBe(401)

  // Set up again, as the setup project does, for the next run.
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

  await page.getByRole("link", { name: "I have saved it — continue" }).click()
  await page.getByRole("link", { name: "Skip for now — open PCP" }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible()

  // A new vault: the secret from before is not in it.
  await page.goto("/secrets")
  await expect(
    page.getByRole("listitem").filter({ hasText: `Gone ${RUN}` }),
  ).toHaveCount(0)
})
