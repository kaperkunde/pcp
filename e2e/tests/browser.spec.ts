import { expect, test, type Page } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import {
  allToolText,
  callTool,
  initialize,
  toolText,
  type McpResponse,
} from "../lib/mcp"
import { allowAllTools, createFetchingToken, createToken } from "../lib/ui"

// The browser: the owner adds it, a token that reaches every server gets
// its tools and is told how it works; the first page at a site asks the
// owner; the assistant reads and acts on the page by refs; a link to
// another site stops; the tab's page shows it live, and a click there
// reaches the page as a person's; hand_over waits for the owner on the
// request's page; a site behind a Cloudflare check is waited for when the
// check passes on its own and, when it does not, left to the owner through
// hand_over, and web_fetch reads such a site through the browser; the
// sign-ins outlast the browser and are forgotten on request. The fake
// upstream is on 127.0.0.1, so the token is allowed private addresses first.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Browser user ${RUN}`
const FETCH_TOKEN_NAME = `Browser fetcher ${RUN}`

// What an answer says when a site's check turned up, and what the browser
// adds when the check did not pass in the tab.
const CHALLENGE =
  "Cloudflare is asking this site's visitors to prove they are human before it shows the page."
const STUCK_IN_TAB =
  "It did not pass on its own in this tab: call hand_over so the owner can pass it themselves, then take a snapshot."

let upstream: Upstream
let token: string
let tokenId: string
let tabId: string

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

function refOf(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]
  expect(ref, text).toBeTruthy()
  return ref!
}

async function choose(page: Page, label: string, value: string) {
  const select = page.getByLabel(label, { exact: true })
  await select.selectOption(value)
  await expect(select).toBeEnabled()
  await page.reload()
  await expect(page.getByLabel(label, { exact: true })).toHaveValue(value)
}

test("the owner adds the browser, and a token that reaches it gets its tools and is told how", async ({
  page,
  baseURL,
}) => {
  await page.goto("/browser")
  await page.getByRole("button", { name: "Add the browser" }).click()
  await expect(
    page.getByRole("heading", { name: "For assistants" }),
  ).toBeVisible()
  await expect(page.getByText(/Found at/)).toBeVisible()

  await page.goto("/servers")
  await expect(
    page.getByRole("link", { name: /Browser/ }).first(),
  ).toBeVisible()

  token = await createToken(page, TOKEN_NAME)
  tokenId = page.url().split("/").pop()!
  await expect(
    page.getByRole("heading", { name: "Browser sites" }),
  ).toBeVisible()

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain("browser/hand_over")

  await allowAllTools(page, TOKEN_NAME, "browser")
  await page.goto(`/tokens/${tokenId}`)
  await choose(page, "Web fetch private addresses", "allowed")
})

test("the first page at a site asks the owner, and the assistant then reads and acts on it", async ({
  page,
  baseURL,
}) => {
  const host = new URL(upstream.browserUrl).host
  const asked = await browse(baseURL!, "navigate", {
    url: `${upstream.browserUrl}/form`,
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Open ${host} in the browser?`)).toBeVisible()
  await expect(page.getByText(/keeps your sign-ins/)).toBeVisible()
  await page.getByRole("button", { name: "Always allow this site" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    'textbox "Name"',
  )

  const opened = await browse(baseURL!, "snapshot")
  const text = toolText(opened)
  tabId = text.match(/\/browser\/tabs\/(\S+)/)![1]!
  await browse(baseURL!, "type", {
    ref: refOf(text, /textbox "Name"/),
    text: "Ada",
  })
  const clicked = await browse(baseURL!, "click", {
    ref: refOf(text, /button "Say hello"/),
  })
  expect(toolText(clicked)).toContain("Hello, Ada")

  // A link to another site stops there, and the site is the token's to decide.
  const followed = await browse(baseURL!, "click", {
    ref: refOf(toolText(clicked), /link "Elsewhere"/),
  })
  const other = `localhost:${new URL(upstream.browserUrl).port}`
  expect(toolText(followed)).toContain(`The page tried to open ${other}`)
  expect(upstream.pageHits).toEqual([])

  await page.goto(`/tokens/${tokenId}`)
  await expect(
    page.getByRole("listitem", { name: other, exact: true }),
  ).toBeVisible()
})

test("the tab's page shows it live, and a click there reaches the page as a person's", async ({
  page,
  baseURL,
}) => {
  await browse(baseURL!, "navigate", { url: `${upstream.browserUrl}/button` })

  await page.goto(`/browser/tabs/${tabId}`)
  const frame = page.getByTestId("browser-frame")
  await expect(async () => {
    expect(Number(await frame.getAttribute("data-frames"))).toBeGreaterThan(0)
  }).toPass()
  await expect(page.getByText("Assistants have this tab")).toBeVisible()

  await page.getByRole("button", { name: "Take over" }).click()
  await expect(page.getByText("You have this tab")).toBeVisible()

  // While the owner has it, the assistant's tools leave it alone.
  const refused = await browse(baseURL!, "snapshot")
  expect(toolText(refused)).toContain("taken over")

  // A click in the middle of the picture lands on the page's button: the
  // input is answered once it has been replayed in the tab.
  const replayed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/browser/tabs/${tabId}/input`) &&
      response.status() === 204,
  )
  await frame.click()
  await replayed
  // Hand back offers the token whose tab it is.
  await expect(page.getByLabel("Hand back to")).toHaveValue(tokenId)
  await page.getByRole("button", { name: "Hand back" }).click()
  await expect(page.getByText("Assistants have this tab")).toBeVisible()

  const after = await browse(baseURL!, "snapshot")
  expect(toolText(after)).toContain("Clicked by a person: true")
})

test("hand_over waits for the owner on the request's page, with the tab live", async ({
  page,
  baseURL,
}) => {
  const asked = await browse(baseURL!, "hand_over", {
    message: "Please press the button for me.",
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)![1]!

  const refused = await browse(baseURL!, "snapshot")
  expect(toolText(refused)).toContain("check_permission")

  await page.goto("/servers")
  await page.getByRole("button", { name: /waiting for you/ }).click()
  await page
    .getByRole("menuitem", { name: /An assistant needs you in the browser/ })
    .click()
  await expect(page).toHaveURL(new RegExp(`/permissions/${id}$`))
  await expect(
    page.getByText("It says: Please press the button for me."),
  ).toBeVisible()
  await expect(page.getByTestId("browser-frame")).toBeVisible()
  await expect(page.getByText("You have this tab")).toBeVisible()
  await page.getByRole("button", { name: "Done" }).click()
  await expect(page.getByTestId("permission-outcome")).toBeVisible()

  const checked = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(checked)).toContain(`The owner is done in tab ${tabId}`)
  expect(toolText(await browse(baseURL!, "snapshot"))).toContain(`Tab ${tabId}`)
})

test("a check that passes on its own is waited for, and the page behind it is read", async ({
  baseURL,
}) => {
  const opened = await browse(baseURL!, "navigate", {
    url: `${upstream.browserUrl}/walled`,
  })
  expect(toolText(opened)).toContain("Behind the wall")
  expect(toolText(opened)).not.toContain("Just a moment")
  expect(toolText(opened)).not.toContain(CHALLENGE)
})

test("a check that does not pass stays on the page, and the answer sends the assistant to hand_over", async ({
  baseURL,
}) => {
  // The browser waits twenty seconds for a check to pass before it answers.
  test.setTimeout(120_000)

  const stuck = await browse(baseURL!, "navigate", {
    url: `${upstream.browserUrl}/walled-forever`,
  })
  expect(toolText(stuck)).toContain(CHALLENGE)
  expect(toolText(stuck)).toContain(STUCK_IN_TAB)
  // The assistant decides: nothing asked the owner.
  expect(toolText(stuck)).not.toContain("Not done yet")

  // Every answer that reports the tab says it, not only the one that opened it.
  const snapshot = await browse(baseURL!, "snapshot")
  expect(toolText(snapshot)).toContain(CHALLENGE)
  expect(toolText(snapshot)).toContain(STUCK_IN_TAB)
})

test("web_fetch reads a page behind a check through the browser, and says so when the check does not pass", async ({
  page,
  baseURL,
}) => {
  // The second page waits twenty seconds for a check that never passes.
  test.setTimeout(180_000)

  const host = new URL(upstream.browserUrl).host
  const fetcher = await createFetchingToken(page, FETCH_TOKEN_NAME)
  await choose(page, "Web fetch private addresses", "allowed")

  // The token's own decision for the site comes first, and is the owner's.
  const asked = await callTool(baseURL!, fetcher.token, "web_fetch", {
    url: `${upstream.browserUrl}/walled`,
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Fetch a page from ${host}?`)).toBeVisible()
  await page.getByRole("button", { name: "Always allow this site" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "Behind the wall",
    { timeout: 60_000 },
  )

  const outcome = await callTool(baseURL!, fetcher.token, "check_permission", {
    id: id!,
  })
  expect(toolText(outcome)).toContain("Behind the wall")
  expect(toolText(outcome)).toContain(
    "read through PCP's browser, after the site's check",
  )
  expect(toolText(outcome)).not.toContain("Just a moment")

  // A check that never passes: the answer says so and points at the browser,
  // which this token reaches. The site is allowed now, so nothing asks.
  const stuck = await callTool(baseURL!, fetcher.token, "web_fetch", {
    url: `${upstream.browserUrl}/walled-forever`,
  })
  expect(allToolText(stuck)).not.toContain("Not done yet")
  expect(allToolText(stuck)).toContain(CHALLENGE)
  expect(allToolText(stuck)).toContain("browser/navigate")
  expect(allToolText(stuck)).toContain("browser/hand_over")
  expect(allToolText(stuck)).not.toContain("Behind the wall")
})

test("the sign-ins outlast the browser, and are gone once forgotten", async ({
  page,
  baseURL,
}) => {
  await page.goto("/browser")
  await expect(page.getByTestId("browser-profile")).toContainText("Kept for")
  await page.getByRole("button", { name: "Close the browser" }).click()
  await expect(page.getByText(/Not running/)).toBeVisible()

  const again = await browse(baseURL!, "navigate", {
    url: `${upstream.browserUrl}/cookie`,
  })
  // The check that passed in a tab left its clearance cookie in the profile
  // too, as any cookie, and the browser has no say in the order of the two.
  expect(toolText(again)).toMatch(/Cookie: .*seen=yes/)
  expect(toolText(again)).toContain("cf_clearance=passed")

  page.once("dialog", (dialog) => void dialog.accept())
  await page.reload()
  await page.getByRole("button", { name: "Forget all sites" }).click()
  await expect(page.getByTestId("browser-profile")).toContainText(
    "Nothing kept yet.",
  )

  const forgotten = await browse(baseURL!, "navigate", {
    url: `${upstream.browserUrl}/cookie`,
  })
  expect(toolText(forgotten)).toContain("Cookie: none")
})
