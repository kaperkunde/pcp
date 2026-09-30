import { expect, type Page } from "@playwright/test"

import { OWNER_PASSWORD } from "./auth"

/** Adds a text secret through the Secrets page. */
export async function addSecret(
  page: Page,
  {
    name,
    value,
    description = "",
  }: { name: string; value: string; description?: string },
) {
  await page.goto("/secrets")
  await page.getByLabel("Name", { exact: true }).fill(name)
  if (description) {
    await page.getByLabel("Description (optional)").fill(description)
  }
  await page.getByLabel("Value").fill(value)
  await page.getByRole("button", { name: "Save secret" }).click()
  await expect(
    page.getByRole("listitem").filter({ hasText: name }).first(),
  ).toBeVisible()
}

/** Creates an API token for every server and returns it. */
export async function createToken(
  page: Page,
  name: string,
  password = OWNER_PASSWORD,
): Promise<string> {
  await page.goto("/tokens")
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("Your password").fill(password)
  await page.getByRole("button", { name: "Create token" }).click()
  await expect(page.getByText("Your new token")).toBeVisible()
  const token = await page.getByTestId("new-token").textContent()
  expect(token).toMatch(/^pcp_/)
  return token!
}
