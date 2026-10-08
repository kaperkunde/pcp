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

/**
 * Creates an API token for every server and returns it. Creating one opens
 * its own page, with the token shown once at the top.
 */
export async function createToken(
  page: Page,
  name: string,
  password = OWNER_PASSWORD,
): Promise<string> {
  await page.goto("/tokens")
  await page.getByLabel("Name").fill(name)
  await page.getByRole("button", { name: "Create token" }).click()
  await confirmWithPassword(page, password)
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)
  await expect(page.getByRole("heading", { name })).toBeVisible()
  await expect(page.getByText("Your new token")).toBeVisible()
  const token = await page.getByTestId("new-token").textContent()
  expect(token).toMatch(/^pcp_/)
  return token!
}

/**
 * Creates an API token for every server that may also fetch web pages, and
 * returns it with its id. Creating one opens its own page.
 */
export async function createFetchingToken(
  page: Page,
  name: string,
  password = OWNER_PASSWORD,
): Promise<{ token: string; id: string }> {
  await page.goto("/tokens")
  await page.getByLabel("Name").fill(name)
  await page
    .getByLabel("Let an assistant with this token fetch web pages")
    .check()
  await page.getByRole("button", { name: "Create token" }).click()
  await confirmWithPassword(page, password)
  await expect(page.getByText("Your new token")).toBeVisible()
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)

  return {
    token: (await page.getByTestId("new-token").textContent())!,
    id: page.url().split("/").pop()!,
  }
}

/**
 * Answers the token form's password step. The form that asks holds the
 * account and the password and nothing else a password manager would fill:
 * anything more and Safari takes it for a sign-up and offers to generate a
 * new password instead of filling the saved one.
 */
export async function confirmWithPassword(page: Page, password: string) {
  const field = page.getByLabel("Your password")
  await expect(field).toHaveAttribute("autocomplete", "current-password")

  const fillable = await field.evaluate((input) =>
    [...(input as HTMLInputElement).form!.elements]
      .filter(
        (element): element is HTMLInputElement =>
          element instanceof HTMLInputElement && element.type !== "hidden",
      )
      .map((element) => element.autocomplete),
  )
  expect(fillable).toEqual(["username", "current-password"])
  await expect(page.getByLabel("Account")).not.toHaveValue("")

  await field.fill(password)
  await page.getByRole("button", { name: "Confirm" }).click()
}

/** Opens a token's page from the token list; returns the token's id. */
export async function openToken(page: Page, name: string): Promise<string> {
  await page.goto("/tokens")
  await page.getByRole("link", { name, exact: true }).click()
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)
  return page.url().split("/").pop()!
}

/**
 * Unfolds the tool list on a server's own page, which starts folded.
 */
export async function showServerTools(page: Page) {
  const toggle = page.getByRole("button", { name: /^Tools \(\d+\)$/ })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

/**
 * Unfolds a server's tools on a token's page: each server shows only a
 * count of its tools until it is opened.
 */
export async function showTools(page: Page, slug: string) {
  const toggle = page
    .locator("button[aria-expanded]")
    .filter({ has: page.getByText(slug, { exact: true }) })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
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
  await showTools(page, slug)

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

/**
 * Opens the "Advanced" disclosure on a server's page, where its settings
 * form sits, once that form is on the page. Does nothing when the page
 * shows the form unfolded.
 */
export async function openAdvanced(page: Page) {
  await expect(
    page.getByRole("button", { name: "Save changes" }).first(),
  ).toBeAttached()
  const advanced = page.locator("details", {
    has: page.locator("summary", { hasText: /^Advanced/ }),
  })
  if (
    (await advanced.count()) > 0 &&
    (await advanced.first().getAttribute("open")) === null
  ) {
    await advanced.first().locator("summary").first().click()
  }
}

/**
 * Chooses one option of a SegmentedControl by its label. Its radio is
 * visually hidden under the label, which takes the click, so a radio's
 * check() never finds it clickable.
 */
export async function chooseSegment(page: Page, label: string) {
  await page.locator("label", { hasText: new RegExp(`^${label}$`) }).click()
  await expect(
    page.getByRole("radio", { name: label, exact: true }),
  ).toBeChecked()
}

/** Opens "More options" on an add form. */
export async function openMoreOptions(page: Page) {
  const more = page.locator("details", {
    has: page.locator("summary", { hasText: /^More options/ }),
  })
  if ((await more.getAttribute("open")) === null) {
    await more.locator("summary").click()
  }
}
