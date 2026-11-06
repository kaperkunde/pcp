import { expect, test, type Page } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { loadState, saveState } from "../lib/state"
import {
  addSecret,
  clickHydrated,
  createToken,
  permissionFrom,
  showServerSettings,
} from "../lib/ui"

// How the owner's key pages look, at a desktop window and a phone's width,
// compared with the pictures in e2e/screenshots (taken in CI, whose Chromium
// and fonts they belong to). A change to a page's look shows here as a
// failed comparison; the pictures change only when the look is meant to.
//
// The project runs right after setup, on the fresh database `pnpm test:e2e`
// makes, so the pages hold only what this spec adds: one secret, one server
// on the fake upstream, one token and one request waiting for the owner.
// What changes by itself (times, versions, addresses) is masked.
test.describe.configure({ mode: "serial" })

const SECRET_NAME = "Postcard key"
const SERVER_NAME = "Postcards"
const SLUG = "postcards"
const TOKEN_NAME = "Claude Code"

const SIZES = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 375, height: 812 },
} as const

/**
 * The pages the first test made, kept on disk: a failed comparison starts
 * a new worker, which would not have them in memory.
 */
type ScreensState = { serverPath: string; requestPath: string }

let upstream: Upstream

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

/** What changes from run to run, covered in the picture. */
function changing(page: Page) {
  return [
    page.locator("time"),
    // PCP's version, in the sidebar and at the foot of Settings.
    page.getByText(/^(PCP )?v\d+\.\d+\.\d+/),
    page.getByTestId("new-token"),
    // The fake upstream's port, a new one each run.
    page.getByText(/127\.0\.0\.1:\d+/),
  ]
}

async function shoot(page: Page, name: string) {
  await page.waitForLoadState("networkidle")
  // Fonts and the icons are in before the picture is taken.
  await page.evaluate(() => document.fonts.ready)
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    mask: changing(page),
    maxDiffPixelRatio: 0.01,
  })
}

/** The same page at both widths. */
async function shootBoth(page: Page, name: string, path: string) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    await page.setViewportSize(viewport)
    await page.goto(path)
    await shoot(page, `${name}-${size}`)
  }
}

test("adds what the pages show", async ({ page, baseURL }) => {
  await addSecret(page, {
    name: SECRET_NAME,
    value: upstream.expectedToken,
    description: "Signs PCP in to the postcard service.",
  })

  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.mcpUrl)
  await page.getByLabel("Description").fill("Sends postcards and adds numbers.")
  await page.getByLabel("Authentication").selectOption("header")
  await page.getByLabel("Secret").selectOption({ label: SECRET_NAME })
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  const serverPath = new URL(page.url()).pathname
  await expect(page.getByText("Tools (3)")).toBeVisible()
  await showServerSettings(page)
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  const token = await createToken(page, TOKEN_NAME)

  // A tool nobody decided on asks first: one request waits for the owner.
  const asked = await callTool(baseURL!, token, "call_tool_destructive", {
    server: SLUG,
    tool: "add_numbers",
    arguments: { a: 19, b: 23 },
  })
  expect(toolText(asked)).toContain("Not done yet")
  const requestPath = permissionFrom(toolText(asked)).path
  saveState("screens", { serverPath, requestPath } satisfies ScreensState)
})

test.describe("signed out", () => {
  test.use({
    storageState: { cookies: [], origins: [] },
    // Signing in is limited per address: an address of this project's own.
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.200" },
  })

  test("unlock", async ({ page }) => {
    await shootBoth(page, "unlock", "/login")
  })

  test("unlock with a wrong password", async ({ page }) => {
    for (const [size, viewport] of Object.entries(SIZES)) {
      await page.setViewportSize(viewport)
      await page.goto("/login")
      await page.getByLabel("Password").fill("not the password")
      await page.getByRole("button", { name: "Unlock" }).click()
      await expect(page.locator("p[role=alert]")).toHaveText(/not right/)
      await page.getByLabel("Password").blur()
      await shoot(page, `unlock-error-${size}`)
    }
  })
})

test("home", async ({ page }) => {
  await shootBoth(page, "home", "/home")
})

test("servers", async ({ page }) => {
  await shootBoth(page, "servers", "/servers")
})

test("one server", async ({ page }) => {
  await shootBoth(page, "server", loadState<ScreensState>("screens").serverPath)
})

test("secrets", async ({ page }) => {
  await shootBoth(page, "secrets", "/secrets")
})

test("a dialog open", async ({ page }) => {
  for (const [size, viewport] of Object.entries(SIZES)) {
    await page.setViewportSize(viewport)
    await page.goto("/secrets")
    await clickHydrated(page.getByRole("button", { name: "Add a secret" }))
    await expect(
      page.getByRole("dialog", { name: "Add a secret" }),
    ).toBeVisible()
    await shoot(page, `secret-dialog-${size}`)
  }
})

test("assistants", async ({ page }) => {
  await shootBoth(page, "tokens", "/tokens")
})

test("a request waiting for the owner", async ({ page }) => {
  await shootBoth(
    page,
    "request",
    loadState<ScreensState>("screens").requestPath,
  )
})

test("settings", async ({ page }) => {
  await shootBoth(page, "settings", "/settings")
})

test("browser", async ({ page }) => {
  await shootBoth(page, "browser", "/browser")
})
