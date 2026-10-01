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

/** Opens a token's page from the token list; returns the token's id. */
export async function openToken(page: Page, name: string): Promise<string> {
  await page.goto("/tokens")
  await page.getByRole("link", { name, exact: true }).click()
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)
  return page.url().split("/").pop()!
}

/**
 * Lets a token run every tool on one server without asking the owner
 * first (tools ask by default).
 */
export async function allowAllTools(
  page: Page,
  tokenName: string,
  slug: string,
) {
  await openToken(page, tokenName)
  await page
    .getByLabel(`All tools on ${slug}`, { exact: true })
    .selectOption("allowed")
  await page
    .getByRole("button", { name: `Set all tools on ${slug}`, exact: true })
    .click()

  // Slugs are lower-case letters, digits and dashes: safe in a pattern.
  const tools = page.getByRole("combobox", {
    name: new RegExp(`^Access to ${slug}/`),
  })
  await expect(async () => {
    const values = await tools.evaluateAll((selects) =>
      selects.map((select) => (select as HTMLSelectElement).value),
    )
    expect(values.length).toBeGreaterThan(0)
    expect(values.every((value) => value === "allowed")).toBe(true)
  }).toPass()
}
