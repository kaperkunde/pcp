import { expect, type Page, test } from "@playwright/test"

import pkg from "../../package.json"
import { startUpstream, type Upstream } from "../fixtures/upstream"
import { E2E_RELEASES_PORT } from "../lib/network"

// The update check from Settings. GitHub is the fake upstream's
// /releases/latest on a fixed port (PCP_RELEASES_URL in playwright.config.ts):
// Check now reads it, the header says when a newer PCP is out, and the card
// says how this PCP is updated. The dev server runs from a checkout.
test.describe.configure({ mode: "serial" })

const NEWER = "99.0.0"
let upstream: Upstream

test.beforeAll(async () => {
  upstream = await startUpstream({ port: E2E_RELEASES_PORT })
})

test.afterAll(async () => {
  await upstream.close()
})

function release(version: string) {
  return {
    tag_name: `v${version}`,
    published_at: "2026-10-01T10:00:00Z",
    body: "## What's new\n- Everything is faster",
    // Never used: the link is built from PCP's own repository address.
    html_url: "https://elsewhere.example/release",
    assets: [{ name: "PCP-mac-arm64.dmg" }],
  }
}

async function checkNow(page: Page) {
  const form = page.getByRole("form", { name: "Check for updates" })
  await form.getByRole("button", { name: "Check now" }).click()
  return form
}

test("Check now finds a newer release, and the header says so", async ({
  page,
}) => {
  upstream.releases.latest = release(NEWER)
  await page.goto("/settings")

  const form = await checkNow(page)
  await expect(form.getByRole("status")).toHaveText(`v${NEWER} is available.`)

  const status = page.getByTestId("updates-status")
  await expect(status).toContainText("Update available")
  await expect(status).toContainText(
    `v${NEWER} is out. This PCP is v${pkg.version}.`,
  )
  await expect(
    status.getByRole("link", { name: "What's new" }),
  ).toHaveAttribute(
    "href",
    `https://github.com/kaperkunde/pcp/releases/tag/v${NEWER}`,
  )
  await status.getByText("Release notes").click()
  await expect(status.getByText("- Everything is faster")).toBeVisible()

  // GitHub was sent the version and nothing of the owner's.
  const sent = upstream.releases.requests.at(-1)
  expect(sent?.userAgent).toMatch(
    new RegExp(`^PCP/${pkg.version.replaceAll(".", "\\.")} `),
  )
  expect(sent?.accept).toBe("application/vnd.github+json")
  expect(sent?.authorization).toBeNull()
  expect(sent?.cookie).toBeNull()

  // The header: the version link as it was, the notice beside it.
  const notice = page.getByRole("link", { name: `v${NEWER} available` })
  await expect(notice).toHaveAttribute("href", "/settings#updates")
  await expect(
    page.getByRole("link", { name: `PCP v${pkg.version}` }),
  ).toBeVisible()

  await page.goto("/servers")
  await expect(notice).toBeVisible()
  await notice.click()
  await expect(page).toHaveURL(/\/settings#updates$/)
})

test("the card says how this PCP is updated", async ({ page }) => {
  await page.goto("/settings")
  const card = page.locator("#updates")

  await expect(
    card.getByRole("heading", { name: "How to update this PCP" }),
  ).toBeVisible()
  await expect(card).toContainText("This PCP runs from a checkout.")
  await expect(
    card.getByText(
      "git pull && pnpm install && pnpm db:generate && pnpm build",
    ),
  ).toBeVisible()
})

test("a release that is this one takes the notice away", async ({ page }) => {
  upstream.releases.latest = release(pkg.version)
  await page.goto("/settings")

  const form = await checkNow(page)
  await expect(form.getByRole("status")).toHaveText(
    `You have the latest release, v${pkg.version}.`,
  )
  await expect(page.getByTestId("updates-status")).toContainText("Up to date")
  await expect(
    page.getByRole("link", { name: /^v[\d.]+ available$/ }),
  ).toHaveCount(0)
})

test("a failed check says why and keeps what PCP knew", async ({ page }) => {
  upstream.releases.latest = null
  await page.goto("/settings")

  const form = await checkNow(page)
  await expect(form.getByRole("alert")).toHaveText(
    "GitHub has no published release to compare with.",
  )
  await expect(page.getByTestId("updates-status")).toContainText("Up to date")

  upstream.releases.latest = release(pkg.version)
})

test("the daily check turns off and on, from Settings and the setup step", async ({
  page,
}) => {
  await page.goto("/settings")
  const daily = page.getByRole("form", { name: "Daily check for new releases" })

  await expect(daily).toContainText("PCP checks for new releases once a day.")
  await daily.getByRole("button", { name: "Turn off the daily check" }).click()
  await expect(daily).toContainText(
    "PCP does not check for new releases by itself.",
  )
  await expect(daily).toContainText(
    "While this is off, nothing is sent unless you choose Check now.",
  )

  await page.goto("/setup/network")
  const setupDaily = page.getByRole("form", {
    name: "Daily check for new releases",
  })
  await expect(setupDaily).toContainText(
    "PCP does not check for new releases by itself.",
  )
  await setupDaily
    .getByRole("button", { name: "Turn on the daily check" })
    .click()
  await expect(setupDaily).toContainText(
    "PCP checks for new releases once a day.",
  )

  await page.goto("/settings")
  await expect(daily).toContainText("PCP checks for new releases once a day.")
})
