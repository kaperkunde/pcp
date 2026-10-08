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
 * Creates an API token for every server and returns it, through the
 * "Connect an assistant" sheet on Assistants. It ends on the token's own
 * page. connectAssistant (below) takes the options.
 */
export async function createToken(
  page: Page,
  name: string,
  password = OWNER_PASSWORD,
): Promise<string> {
  return (await connectAssistant(page, name, {}, password)).token
}

/**
 * Creates an API token for every server that may also fetch web pages, and
 * returns it with its id. It ends on the token's own page.
 */
export async function createFetchingToken(
  page: Page,
  name: string,
  password = OWNER_PASSWORD,
): Promise<{ token: string; id: string }> {
  return connectAssistant(page, name, { webFetch: true }, password)
}

/**
 * Answers a password step (a new API token, an export, an app signing in).
 * The form that asks holds the account and the password and nothing else a
 * password manager would fill: anything more and Safari takes it for a
 * sign-up and offers to generate a new password instead of filling the
 * saved one. It is sent with its own submit button, whatever its words.
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
  await page
    .locator("form")
    .filter({ has: field })
    .locator('button[type="submit"]')
    .click()
}

/** Opens a token's page from Assistants; returns the token's id. */
export async function openToken(page: Page, name: string): Promise<string> {
  await page.goto("/tokens")
  await page
    .getByRole("link")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click()
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
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
 * Unfolds a server's tools on a token's page (or its Advanced page): each
 * server shows only how many it may run until it is opened.
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
 * first (tools ask by default). Ends on the token's page with the server's
 * tools unfolded.
 */
export async function allowAllTools(
  page: Page,
  tokenName: string,
  slug: string,
) {
  await openToken(page, tokenName)
  page.once("dialog", (dialog) => dialog.accept())
  await page
    .getByLabel(`All tools on ${slug}`, { exact: true })
    .selectOption("allowed")
  await showTools(page, slug)

  // Slugs are lower-case letters, digits and dashes: safe in a pattern.
  const levels = page.getByRole("group", {
    name: new RegExp(`^Access to ${slug}/`),
  })
  await expect(async () => {
    const allowed = await levels.evaluateAll((groups) =>
      groups.map(
        (group) =>
          group.querySelector<HTMLInputElement>('input[value="allowed"]')
            ?.checked === true,
      ),
    )
    expect(allowed.length).toBeGreaterThan(0)
    expect(allowed.every(Boolean)).toBe(true)
  }).toPass()
}

/** What a new token may do besides running tools, and what it reaches. */
export type TokenOptions = {
  /** Server names it reaches; every server when left out. */
  servers?: string[]
  keepMemories?: boolean
  webFetch?: boolean
  runCode?: boolean
  manageEndpoints?: boolean
  manageWrappers?: boolean
}

/** The switches under More options in the connect sheet. */
const OPTION_LABELS = {
  keepMemories: "Keep memories",
  webFetch: "Read web pages",
  runCode: "Run code",
  manageEndpoints: "Manage API endpoints",
  manageWrappers: "Propose wrappers",
} as const

/**
 * Fills the connect sheet's first step (name, servers, options) and goes on
 * to the password step, which is left to the caller.
 */
export async function startConnecting(
  page: Page,
  name: string,
  options: TokenOptions = {},
) {
  await page.goto("/tokens")
  await page.getByRole("button", { name: "Connect an assistant" }).click()
  const sheet = page.getByRole("dialog")
  // A token to paste, as Claude Code takes it (a Claude app signs in at PCP
  // instead: oauth-server.spec.ts).
  await sheet.getByText("Claude Code", { exact: true }).click()
  await sheet.getByLabel("Name", { exact: true }).fill(name)

  if (options.servers) {
    await sheet.getByText("Only some", { exact: true }).click()
    for (const server of options.servers) {
      await sheet.getByLabel(server).check()
    }
  }

  const switches = (
    Object.keys(OPTION_LABELS) as Array<keyof typeof OPTION_LABELS>
  ).filter((option) => options[option])
  if (switches.length > 0) {
    await sheet.getByText("More options", { exact: true }).click()
    for (const option of switches) {
      // Anchored: a row's name runs on into its caption.
      await sheet
        .getByRole("switch", { name: new RegExp(`^${OPTION_LABELS[option]}`) })
        .check()
    }
  }

  await sheet.getByRole("button", { name: "Continue" }).click()
}

/**
 * Connects an assistant through the sheet: the first step, the password,
 * the token shown once (returned with its id), then Done, which opens the
 * token's page.
 */
export async function connectAssistant(
  page: Page,
  name: string,
  options: TokenOptions = {},
  password = OWNER_PASSWORD,
): Promise<{ token: string; id: string }> {
  await startConnecting(page, name, options)
  await confirmWithPassword(page, password)
  const shown = page.getByTestId("new-token")
  await expect(shown).toHaveText(/^pcp_/)
  const token = (await shown.textContent())!
  await page.getByRole("button", { name: "Done" }).click()
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
  return { token, id: page.url().split("/").pop()! }
}

/** Opens a token's Advanced page (expiry, All tokens, web fetch, proposing). */
export async function openTokenAdvanced(page: Page, tokenId: string) {
  await page.goto(`/tokens/${tokenId}/advanced`)
  await expect(
    page.getByRole("heading", { name: "Advanced", level: 1 }),
  ).toBeVisible()
}

/** The words on each level's segment. */
const LEVEL_WORDS = {
  default: "By method",
  allowed: "Allow",
  ask: "Ask",
  blocked: "Block",
} as const

type Level = keyof typeof LEVEL_WORDS

/**
 * Picks a level in one of the token pages' segmented controls, named by its
 * legend ("Access to <slug>/<tool>", "Web fetch <site or method>"), and
 * waits for it to be saved.
 */
export async function chooseLevel(page: Page, legend: string, level: Level) {
  const group = page.getByRole("group", { name: legend, exact: true })
  await group.getByText(LEVEL_WORDS[level], { exact: true }).click()
  const radio = group.getByRole("radio", { name: LEVEL_WORDS[level] })
  await expect(radio).toBeChecked()
  await expect(radio).toBeEnabled()
}

/** Checks the level a segmented control shows. */
export async function expectLevel(page: Page, legend: string, level: Level) {
  await expect(
    page
      .getByRole("group", { name: legend, exact: true })
      .getByRole("radio", { name: LEVEL_WORDS[level], exact: true }),
  ).toBeChecked()
}

/** A tool's level on the token's page, for one token. */
export async function setToolLevel(
  page: Page,
  slug: string,
  tool: string,
  level: Exclude<Level, "default">,
) {
  await showTools(page, slug)
  await chooseLevel(page, `Access to ${slug}/${tool}`, level)
}

/**
 * Turns private addresses (web fetch and the browser) on or off for a
 * token, on its Advanced page, and waits for it to be saved.
 */
export async function setPrivateAddresses(page: Page, allowed: boolean) {
  const toggle = page.getByRole("switch", { name: /^Private addresses/ })
  await toggle.setChecked(allowed)
  await expect(toggle).toBeEnabled()
  await expect(toggle).toBeChecked({ checked: allowed })
}

/**
 * A folded row of the Settings page ("Password", "Touch ID", "Export"),
 * opened: the row is a disclosure, and its form is not on screen until it
 * is. Returns the row to look for the form's fields and buttons in.
 */
export async function openSettingsRow(page: Page, title: string) {
  const row = page.locator("details[data-slot=disclosure]").filter({
    has: page.locator("summary").getByText(title, { exact: true }),
  })

  if ((await row.getAttribute("open")) === null) {
    await row.locator("summary").first().click()
  }

  await expect(row).toHaveAttribute("open", "")
  return row
}

/**
 * Unfolds Advanced on a server's page: its settings form (name, short name,
 * address, sign-in) lives there, folded until asked for.
 */
export async function showServerSettings(page: Page) {
  const advanced = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Advanced/ }) })
    .first()
  if (!(await advanced.evaluate((element) => element.hasAttribute("open")))) {
    await advanced.locator("summary").first().click()
  }
  await expect(advanced).toHaveAttribute("open", "")
}

/**
 * Goes to a kind's add page through the Servers page's Add menu: "MCP
 * server", "API endpoint", "Mail account", "SSH server", "Wrapper".
 */
export async function addServerFromMenu(page: Page, kind: string) {
  await page.goto("/servers")
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await page.getByRole("menuitem", { name: new RegExp(`^${kind}`) }).click()
}
