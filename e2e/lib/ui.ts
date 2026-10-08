import { expect, type Page } from "@playwright/test"

import { OWNER_PASSWORD } from "./auth"

/**
 * Adds a text secret through the Secrets page: "Add a secret" opens a sheet
 * with the form, which closes once the secret is saved.
 */
export async function addSecret(
  page: Page,
  {
    name,
    value,
    description = "",
  }: { name: string; value: string; description?: string },
) {
  await page.goto("/secrets")
  await page.getByRole("button", { name: "Add a secret" }).click()
  const dialog = page.getByRole("dialog", { name: "Add a secret" })
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  if (description) {
    await dialog.getByLabel("Description (optional)").fill(description)
  }
  await dialog.getByLabel("Value").fill(value)
  await dialog.getByRole("button", { name: "Save secret" }).click()
  await expect(dialog).toBeHidden()
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

// ---- The owner's answers to requests (permissions, memories) ----------------

/** The permission link in an assistant's result text, and the request's id. */
export function permissionFrom(text: string): { path: string; id: string } {
  const id = text.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, text).toBeTruthy()
  return { path: `/permissions/${id}`, id: id! }
}

/** Accepts the next confirm() the page shows (Delete, Copy access…). */
export function acceptNextDialog(page: Page) {
  page.once("dialog", (dialog) => void dialog.accept())
}

/** The bell in the sidebar that lists what waits for the owner. */
export function bell(page: Page) {
  return page.getByRole("button", { name: /waiting for you/ })
}

/** Opens the bell and follows the request whose title matches. */
export async function openRequestFromBell(page: Page, title: RegExp | string) {
  await expect(bell(page)).toBeVisible()
  await bell(page).click()
  await page.getByRole("menuitem", { name: title }).click()
}

/** The group of levels for one tool on an assistant's proposal. */
export function proposedLevel(page: Page, slug: string, tool: string) {
  return page.getByRole("group", { name: `Access to ${slug}/${tool}` })
}

/**
 * Picks a level on an assistant's proposal for its token's tools: each
 * tool's choice is a group named "Access to <slug>/<tool>" of radio buttons.
 */
export async function chooseProposedLevel(
  page: Page,
  slug: string,
  tool: string,
  level: "Allowed" | "Ask you first" | "Blocked",
) {
  await proposedLevel(page, slug, tool)
    .getByText(level, { exact: true })
    .click()
}

/** A tool's level on its token's page, which the owner reaches from Assistants. */
export function toolLevel(page: Page, slug: string, tool: string) {
  return page.getByLabel(`Access to ${slug}/${tool}`, { exact: true })
}
