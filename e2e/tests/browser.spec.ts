import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText, type McpResponse } from "../lib/mcp"
import {
  allClear,
  allowAllTools,
  answerEverythingWaiting,
  clickHydrated,
  createToken,
  openTokenAdvanced,
  setPrivateAddresses,
} from "../lib/ui"

// The browser: the owner adds it, a token that reaches every server gets
// its tools and is told how it works; the first page at a site asks the
// owner; the assistant reads and acts on the page by refs; a link to
// another site stops; the sign-ins outlast the browser and are forgotten
// on request; the tabs view settles a hand-over on its tab, takes the old
// links there and closes a tab nobody needs. The fake upstream is on
// 127.0.0.1, so the token is allowed private addresses first. The owner's
// input in the live view and Cloudflare checks are covered by
// lib/core/browser's unit tests.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Browser user ${RUN}`

let upstream: Upstream
let token: string
let tokenId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

function browse(
  baseURL: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpResponse> {
  return callTool(baseURL, token, "call_tool", {
    server: "browser",
    tool,
    arguments: args,
  })
}

/** The tab an answer is about ("Tab abc: title"). */
function tabOf(text: string): string {
  const id = text.match(/^Tab (\S+):/m)?.[1]
  expect(id, text).toBeTruthy()
  return id!
}

function refOf(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]
  expect(ref, text).toBeTruthy()
  return ref!
}

test("the owner adds the browser, and a token that reaches it gets its tools and is told how", async ({
  page,
  baseURL,
}) => {
  const nav = page.getByRole("navigation", { name: "Main" })
  const browserItem = nav.getByRole("link", { name: "Browser" })

  await page.goto("/browser")
  // Not added yet: no item of its own, and the page sits under Servers.
  await expect(browserItem).toHaveCount(0)
  await expect(nav.getByRole("link", { name: "Servers" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await page.getByRole("button", { name: "Add the browser" }).click()
  await expect(
    page.getByRole("heading", { name: "For assistants" }),
  ).toBeVisible()
  await expect(page.getByText(/Found at/)).toBeVisible()

  // Added: the sidebar lists it right below Skills, and its page is it.
  await expect(browserItem).toHaveAttribute("aria-current", "page")
  await expect(
    nav
      .getByRole("link", { name: "Skills" })
      .locator("xpath=following-sibling::a[1]"),
  ).toHaveText("Browser")

  await page.goto("/servers")
  await expect(browserItem).not.toHaveAttribute("aria-current", "page")
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: /Browser/ })
      .first(),
  ).toBeVisible()

  token = await createToken(page, TOKEN_NAME)
  tokenId = page.url().split("/").pop()!

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain("browser/hand_over")
  expect(instructions).toContain("browser/upload_file")

  await allowAllTools(page, TOKEN_NAME, "browser")
  // The browser follows the token's web fetch sites, on its Advanced page;
  // the fake site is on loopback.
  await openTokenAdvanced(page, tokenId)
  await expect(
    page.getByRole("heading", { name: "Browser sites" }),
  ).toBeVisible()
  await setPrivateAddresses(page, true)
})

test("the first page at a site asks the owner, and the assistant then reads and acts on it", async ({
  page,
  baseURL,
}) => {
  const host = new URL(upstream.browserUrl).host
  // Every tool but tabs' open and list names its tab, and is refused
  // without one: its schema requires it, so nothing runs.
  const unnamed = await browse(baseURL!, "snapshot")
  expect(toolText(unnamed)).toContain(
    '"tab" is missing; the inputSchema requires it',
  )

  const asked = await browse(baseURL!, "tabs", {
    action: "open",
    url: `${upstream.browserUrl}/form`,
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Open ${host} in the browser?`)).toBeVisible()
  await expect(page.getByText(/keeps your sign-ins/)).toBeVisible()
  await page.getByRole("button", { name: "Always allow this site" }).click()
  // The answer starts Chromium for the first time in the run: a few seconds
  // when its files are cached, more than ten on a machine that just started.
  await expect(page.getByTestId("permission-outcome")).toContainText(
    'textbox "Name"',
    { timeout: 30_000 },
  )

  // The answer the owner allowed names the new tab first.
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "Opened a new tab:",
  )
  const tab = (await page
    .getByTestId("permission-outcome")
    .textContent())!.match(/Opened a new tab: (\S+)\./)![1]!

  const opened = await browse(baseURL!, "snapshot", { tab })
  const text = toolText(opened)
  expect(tabOf(text)).toBe(tab)
  await browse(baseURL!, "type", {
    tab,
    ref: refOf(text, /textbox "Name"/),
    text: "Ada",
  })
  // By role and name, as a program without refs would.
  const clicked = await browse(baseURL!, "click", {
    tab,
    target: { role: "button", name: "Say hello" },
  })
  expect(toolText(clicked)).toContain("Hello, Ada")

  // find answers elements as JSON.
  const found = JSON.parse(
    toolText(await browse(baseURL!, "find", { tab, text: "Hello" })),
  ) as { matches: Array<{ role: string; name?: string }> }
  expect(found.matches).toContainEqual(
    expect.objectContaining({ role: "heading", name: "Hello, Ada" }),
  )

  // A link to another site stops there, and the site is the token's to decide.
  const followed = await browse(baseURL!, "click", {
    tab,
    ref: refOf(toolText(clicked), /link "Elsewhere"/),
  })
  const other = `localhost:${new URL(upstream.browserUrl).port}`
  expect(toolText(followed)).toContain(`The page tried to open ${other}`)
  expect(upstream.pageHits).toEqual([])

  await openTokenAdvanced(page, tokenId)
  await expect(
    page.getByRole("listitem", { name: other, exact: true }),
  ).toBeVisible()
})

test("the sign-ins outlast the browser, and are gone once forgotten", async ({
  page,
  baseURL,
}) => {
  await page.goto("/browser")
  await expect(page.getByTestId("browser-profile")).toContainText("Kept for")
  await page.getByRole("button", { name: "Close the browser" }).click()
  await expect(page.getByText(/Not running/)).toBeVisible()

  const again = await browse(baseURL!, "tabs", {
    action: "open",
    url: `${upstream.browserUrl}/cookie`,
  })
  // The cookie the form set before the browser closed.
  expect(toolText(again)).toMatch(/Cookie: .*seen=yes/)

  page.once("dialog", (dialog) => void dialog.accept())
  await page.reload()
  await page.getByRole("button", { name: "Forget all sites" }).click()
  await expect(page.getByTestId("browser-profile")).toContainText(
    "Nothing kept yet.",
  )

  const forgotten = await browse(baseURL!, "tabs", {
    action: "open",
    url: `${upstream.browserUrl}/cookie`,
  })
  expect(toolText(forgotten)).toContain("Cookie: none")
})

test("the tabs view: a hand-over answered on its tab, old links led there, a stale tab closed", async ({
  page,
  baseURL,
}) => {
  // What earlier projects left waiting, out of the way: this hand-over is
  // then the last thing waiting.
  await answerEverythingWaiting(page)
  const opened = toolText(
    await browse(baseURL!, "tabs", {
      action: "open",
      url: `${upstream.browserUrl}/form`,
    }),
  )
  const tab = opened.match(/Opened a new tab: (\S+)\./)?.[1] ?? tabOf(opened)
  const row = page.locator(`[data-tab-id="${tab}"]`)
  const inView = new RegExp(`/browser\\?tab=${tab}$`)

  // The assistant hands the tab over; its link leads to the tab itself.
  const asked = toolText(
    await browse(baseURL!, "hand_over", {
      tab,
      message: "Please sign in for me.",
    }),
  )
  expect(asked).toContain("Not done yet")
  const id = asked.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, asked).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(page).toHaveURL(inView)
  const waiting = row.getByRole("group", { name: "Waiting for you" })
  await expect(waiting).toContainText("Waiting for you: Please sign in for me.")
  await expect(row.getByTestId("tab-state")).toHaveText("With you")
  await expect(row).toHaveAttribute("aria-current", "true")
  await expect(page.getByTestId("browser-frame")).toBeVisible()

  // Done, on the tab: it goes back to the assistant, and nothing waits on it.
  await clickHydrated(waiting.getByRole("button", { name: "Done" }))
  await expect(
    page.getByRole("region", { name: "Your last answer" }),
  ).toContainText("An assistant needs you in the browser")
  await expect(allClear(page)).toBeVisible()
  await expect(page).toHaveURL(inView)
  await expect(waiting).toHaveCount(0)
  await expect(row.getByTestId("tab-state")).toHaveText("Idle")
  expect(
    toolText(await callTool(baseURL!, token, "check_permission", { id })),
  ).toContain(`The owner is done in tab ${tab}`)

  // The old links: a tab's own page leads into the view; an answered
  // hand-over's page says how it ended.
  await page.goto(`/browser/tabs/${tab}`)
  await expect(page).toHaveURL(inView)
  await page.goto(`/permissions/${id}`)
  await expect(page).toHaveURL(new RegExp(`/permissions/${id}$`))
  await expect(page.getByText("You allowed this and it ran.")).toBeVisible()

  // A tab nobody needs any more is closed from the list.
  await page.goto("/browser")
  await row.getByRole("button", { name: /^Close / }).click()
  await expect(row).toHaveCount(0)
  expect(toolText(await browse(baseURL!, "snapshot", { tab }))).toContain(
    `There is no tab ${tab}`,
  )

  // A tab that is gone says so where its link leads.
  await page.goto(`/browser?tab=${tab}`)
  await expect(
    page.getByRole("region", { name: "Live tab" }).getByRole("alert"),
  ).toContainText("This tab is closed")
})
