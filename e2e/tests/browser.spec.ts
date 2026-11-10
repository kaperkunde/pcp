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
// links there and closes a tab nobody needs; a secret for the browser is
// asked for with its login name and a password PCP makes, and its sites
// changed on request. The fake upstream is on
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
  return callTool(baseURL, token, "call_tool_destructive", {
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

  // Added: the sidebar lists it right below Files, and its page is it.
  await expect(browserItem).toHaveAttribute("aria-current", "page")
  await expect(
    nav
      .getByRole("link", { name: "Files" })
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
    .textContent())!.match(/Opened a new tab: ([^\s.]+)[ .]/)![1]!

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

  // A sign-in made elsewhere, imported by the owner: previewed, then kept.
  await page.reload()
  await page.getByText("Import a sign-in").click()
  await page
    .getByLabel("Cookie export", { exact: true })
    .fill(
      `.example.com\tTRUE\t/\tTRUE\t${Math.floor(Date.now() / 1000) + 86_400}\tsid\tabc\n127.0.0.1\tFALSE\t/\tFALSE\t0\tlocal\t1`,
    )
  await page.getByRole("button", { name: "Preview" }).click()
  const preview = page.getByTestId("browser-import-preview")
  await expect(preview).toContainText("a cookies.txt file: 1 cookie")
  await expect(preview).toContainText("example.com")
  await expect(preview).toContainText(
    "Left out: 1 for an IP address rather than a site's name.",
  )
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByText("Imported 1 cookie for 1 site.")).toBeVisible()
  await expect(page.getByTestId("browser-profile")).toContainText(
    "Kept for 1 site (1 cookie)",
  )
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
  const tab =
    opened.match(/Opened a new tab: ([^\s.]+)[ .]/)?.[1] ?? tabOf(opened)
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

test("the live view: Take over and Hand back switch back and forth without a reload", async ({
  page,
  baseURL,
}) => {
  const opened = toolText(
    await browse(baseURL!, "tabs", {
      action: "open",
      url: `${upstream.browserUrl}/form`,
    }),
  )
  const tab =
    opened.match(/Opened a new tab: ([^\s.]+)[ .]/)?.[1] ?? tabOf(opened)

  // The page's own refresh is slow (a busy page makes the tab list slow to
  // draw): the buttons must not wait for it.
  await page.route(/\/browser\?.*_rsc=/, async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    await route.continue().catch(() => {})
  })
  await page.goto(`/browser?tab=${tab}`)
  const live = page.getByRole("region", { name: "Live tab" })
  await expect(page.getByTestId("browser-frame")).toBeVisible()

  // Each switch leaves the button enabled and offering the opposite action.
  for (let round = 0; round < 2; round += 1) {
    const takeOver = live.getByRole("button", { name: "Take over" })
    await expect(takeOver).toBeEnabled()
    await clickHydrated(takeOver)

    const handBack = live.getByRole("button", { name: "Hand back" })
    await expect(handBack).toBeVisible()
    await expect(handBack).toBeEnabled({ timeout: 4_000 })
    await clickHydrated(handBack)
  }

  await expect(live.getByRole("button", { name: "Take over" })).toBeEnabled({
    timeout: 4_000,
  })
  await expect(live.getByRole("button", { name: /^Close/ })).toBeEnabled()
})

test("the live view: a stream that dropped for a while comes back, and the buttons with it", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000)
  const opened = toolText(
    await browse(baseURL!, "tabs", {
      action: "open",
      url: `${upstream.browserUrl}/form`,
    }),
  )
  const tab =
    opened.match(/Opened a new tab: ([^\s.]+)[ .]/)?.[1] ?? tabOf(opened)

  // The first connections fail (an address that answers 404), enough to
  // use up the quick retries.
  await page.addInitScript(() => {
    const Real = window.EventSource
    let refused = 0
    const w = window as unknown as { __refused: () => number }
    w.__refused = () => refused
    window.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        if (refused < 7) {
          refused += 1
          super("/api/browser/tabs/none/stream", init)
        } else {
          super(url, init)
        }
      }
    } as typeof EventSource
  })
  await page.goto(`/browser?tab=${tab}`)
  const live = page.getByRole("region", { name: "Live tab" })

  // It is not shown as closed for good: once the stream is back, so are
  // the buttons.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __refused: () => number }).__refused(),
        ),
      { timeout: 90_000 },
    )
    .toBe(7)
  await expect(live.getByText("Connection lost")).toHaveCount(0, {
    timeout: 60_000,
  })
  await expect(live.getByText("This tab is closed")).toHaveCount(0)
  const takeOver = live.getByRole("button", { name: "Take over" })
  await expect(takeOver).toBeEnabled()
  await clickHydrated(takeOver)
  await expect(live.getByRole("button", { name: "Hand back" })).toBeEnabled({
    timeout: 4_000,
  })
})

test("a secret for the browser: its login name, a password PCP makes, and its sites changed on request", async ({
  page,
  baseURL,
}) => {
  await answerEverythingWaiting(page)
  const name = `Energy ${RUN}`
  const asked = toolText(
    await browse(baseURL!, "request_secret", {
      name,
      purpose: "To sign up at the energy company.",
      origins: ["https://www.frankenergie.nl"],
      username: "ada@example.com",
      generate: { length: 20, symbols: false },
    }),
  )
  expect(asked).toContain("Not done yet")
  const id = asked.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, asked).toBeTruthy()

  // Marked up for password managers: the login name and a new password
  // together, the sites as boxes out of their reach.
  await page.goto(`/permissions/${id}`)
  const login = page.getByLabel("Login name")
  await expect(login).toHaveValue("ada@example.com")
  await expect(login).toHaveAttribute("autocomplete", "username")
  await expect(login).toHaveAttribute("autocapitalize", "off")
  const generate = page.getByRole("switch", {
    name: /Have PCP make a new password/,
  })
  await expect(generate).toBeChecked()
  await expect(page.getByLabel("Length")).toHaveValue("20")
  // Enter in a field of the form is not Allow: the sites are still unseen.
  await page.getByLabel("Length").press("Enter")
  await login.press("Enter")
  await expect(page.getByTestId("permission-outcome")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Save, allow one use" }),
  ).toBeEnabled()
  await expect(
    page.getByRole("checkbox", { name: "https://www.frankenergie.nl" }),
  ).toBeChecked()
  await expect(page.getByLabel("More sites (optional)")).toHaveAttribute(
    "data-lpignore",
    "true",
  )
  await clickHydrated(generate)
  // Not generating: the password follows the login name in one real form,
  // under the plain pair of hints (Safari puts a "new-password" into the
  // login name), and Allow submits that form.
  const password = page.getByLabel(`Value of the secret "${name}"`)
  await expect(password).toHaveAttribute("autocomplete", "current-password")
  await expect(password).toHaveAttribute("name", "password")
  const form = page.locator("form", { has: login })
  await expect(form.locator("input:not([type=checkbox])")).toHaveCount(2)
  await expect(
    form.locator("input:not([type=checkbox])").nth(0),
  ).toHaveAttribute("name", "username")
  await expect(
    form.locator("input:not([type=checkbox])").nth(1),
  ).toHaveAttribute("name", "password")
  await expect(
    page.getByRole("button", { name: "Save, allow one use" }),
  ).toHaveAttribute("type", "submit")
  await expect(
    page.getByRole("button", { name: "Save, allow one use" }),
  ).toHaveAttribute("form", (await form.getAttribute("id")) ?? "")
  await clickHydrated(generate)

  await clickHydrated(page.getByRole("button", { name: "Save, allow one use" }))
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "PCP made its value itself",
  )
  expect(
    toolText(await callTool(baseURL!, token, "check_permission", { id })),
  ).toContain('"part": "username"')

  // Its sites, on the assistant's proposal: a lookalike is flagged and left
  // unticked, the rest made as ticked.
  const proposed = toolText(
    await browse(baseURL!, "update_secret_sites", {
      name,
      reason: "The site signs in at mijn.frankenergie.nl too.",
      add: [
        { origin: "https://frankenergie.nl", subdomains: true },
        { origin: "https://www.frankenergy.nl" },
      ],
    }),
  )
  expect(proposed).toContain("Not done yet")
  const sitesId = proposed.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(sitesId, proposed).toBeTruthy()

  await page.goto(`/permissions/${sitesId}`)
  await expect(page.getByText(/letter or two away/).first()).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: /www\.frankenergy\.nl/ }),
  ).not.toBeChecked()
  await expect(
    page.getByRole("checkbox", {
      name: /frankenergie\.nl and its subdomains/,
    }),
  ).toBeChecked()
  await clickHydrated(
    page.getByRole("button", { name: "Apply ticked changes" }),
  )
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "Added: https://frankenergie.nl and its subdomains.",
  )
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "Not done: adding https://www.frankenergy.nl.",
  )
})
