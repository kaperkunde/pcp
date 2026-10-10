import { expect, test, type Page } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText, type McpResponse } from "../lib/mcp"
import { allowAllTools, createToken } from "../lib/ui"

// The browser: the owner adds it, a token that reaches every server gets
// its tools and is told how it works; the first page at a site asks the
// owner; the assistant reads and acts on the page by refs; a link to
// another site stops; the tab's page shows it live, and a click there
// reaches the page as a person's; hand_over waits for the owner on the
// request's page; a phone's keyboard and paste reach the page; the
// sign-ins outlast the browser and are forgotten on request. The fake
// upstream is on 127.0.0.1, so the token is allowed private addresses first.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Browser user ${RUN}`

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

// A phone has no keyboard of its own to press keys on a picture: the
// Keyboard button brings up the hidden box, whose edits and the clipboard
// reach the page. (pointer: coarse) is what shows the buttons.
test.describe("on a phone", () => {
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
  })

  async function takeOver(page: Page) {
    await page.goto(`/browser/tabs/${tabId}`)
    const frame = page.getByTestId("browser-frame")
    await expect(async () => {
      expect(Number(await frame.getAttribute("data-frames"))).toBeGreaterThan(0)
    }).toPass()
    await page.getByRole("button", { name: "Take over" }).click()
    await expect(page.getByText("You have this tab")).toBeVisible()
  }

  async function greeting(baseURL: string): Promise<string> {
    const form = await browse(baseURL, "snapshot")
    await browse(baseURL, "click", {
      ref: refOf(toolText(form), /button "Say hello"/),
    })
    await expect(async () => {
      expect(toolText(await browse(baseURL, "snapshot"))).toContain("Hello,")
    }).toPass()
    return toolText(await browse(baseURL, "snapshot"))
  }

  test("the keyboard button brings up a box whose edits type into the page", async ({
    page,
    baseURL,
  }) => {
    const opened = await browse(baseURL!, "navigate", {
      url: `${upstream.browserUrl}/form`,
    })
    await browse(baseURL!, "click", {
      ref: refOf(toolText(opened), /textbox "Name"/),
    })

    await takeOver(page)
    await page.getByTestId("browser-keyboard-button").click()
    const box = page.getByTestId("browser-keyboard")
    await expect(box).toBeFocused()

    // A word typed, a letter taken back and another put in its place: what
    // the keyboard does to the box, not keys pressed on the picture.
    await box.pressSequentially("Adx")
    await box.press("Backspace")
    await box.pressSequentially("a")
    await page.getByRole("button", { name: "Hand back" }).click()
    await expect(page.getByText("Assistants have this tab")).toBeVisible()

    expect(await greeting(baseURL!)).toContain("Hello, Ada")
  })

  test("paste sends the clipboard to the page, or takes it in a box where the browser will not give it", async ({
    page,
    baseURL,
    context,
  }) => {
    const opened = await browse(baseURL!, "navigate", {
      url: `${upstream.browserUrl}/form`,
    })
    await browse(baseURL!, "click", {
      ref: refOf(toolText(opened), /textbox "Name"/),
    })

    await takeOver(page)

    // Where the browser refuses the clipboard, the text goes in a box.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "readText", {
        configurable: true,
        value: () => Promise.reject(new DOMException("No", "NotAllowedError")),
      })
    })
    await page.getByTestId("browser-paste-button").click()
    const pasted = page.getByLabel(/will not hand over the clipboard/)
    await expect(pasted).toBeVisible()
    await pasted.fill("Grace")
    await page.getByRole("button", { name: "Send to the page" }).click()
    await expect(pasted).toBeHidden()

    // Where it gives it, the button pastes it.
    await page.evaluate(() =>
      Reflect.deleteProperty(navigator.clipboard, "readText"),
    )
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.evaluate(() => navigator.clipboard.writeText(" Hopper"))
    await page.getByTestId("browser-paste-button").click()
    await expect(pasted).toBeHidden()

    await page.getByRole("button", { name: "Hand back" }).click()
    await expect(page.getByText("Assistants have this tab")).toBeVisible()

    expect(await greeting(baseURL!)).toContain("Hello, Grace Hopper")
  })
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
  expect(toolText(again)).toContain("Cookie: seen=yes")

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
