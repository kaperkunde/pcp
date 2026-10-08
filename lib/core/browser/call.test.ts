import type { CallToolResult } from "@modelcontextprotocol/server"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { CHALLENGE_LINE } from "../fetch/challenge"
import {
  answerWalled,
  startTestApi,
  WALL_COOKIE,
  type TestApi,
} from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { listFetchRules, setFetchPrivate, setFetchSite } from "../web-fetch"
import { callBrowserTool, finishHandover, performNavigate } from "./call"
import { chromiumExecutable } from "./executable"
import { CHALLENGE_WAIT_MS } from "./limits"
import { loadProfile } from "./profile"
import { closeAllBrowsers, closeBrowser, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"
import { isOwnerNeeded, type OwnerNeeded } from "./types"

// The browser's tools against a real headless Chromium and pages served on
// this machine. Skipped where no Chromium is installed (`pnpm exec
// playwright install chromium`, or PCP_BROWSER_EXECUTABLE). A site's check
// is given a few seconds rather than twenty: the fake one passes in a third
// of a second, or never.

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./limits")>()),
  CHALLENGE_WAIT_MS: 3_000,
}))

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"

let cleanup: () => Promise<void>
let api: TestApi
/** A second site, which the token is never allowed to open. */
let elsewhere: TestApi
let ctx: VaultContext
let tokenId: string
let server: McpServer

const FORM = `<!doctype html><title>Form</title>
<h1 id="greeting">Who are you?</h1>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('greeting').textContent = 'Hello, ' + document.getElementById('name').value; document.cookie = 'seen=1; max-age=3600'">Say hello</button>
<select aria-label="Pet"><option value="dog">Dog</option><option value="cat">Cat</option></select>
<a href="__ELSEWHERE__">Elsewhere</a>`

/** Links to pages behind a site's check, one that passes and one that does not. */
const DOORS = `<!doctype html><title>Doors</title>
<a href="/walled">Passes</a>
<a href="/walled-forever">Stays</a>`

/** What a page's own script can tell of the browser that shows it. */
const FINGERPRINT = `<!doctype html><title>Fingerprint</title>
<pre><code id="seen"></code></pre>
<script>
document.getElementById("seen").textContent = JSON.stringify({
  webdriver: navigator.webdriver,
  userAgent: navigator.userAgent,
  brands: JSON.stringify(navigator.userAgentData?.brands),
  screenWidth: screen.width,
})
</script>`

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  tokenId = (await resolveApiToken(token))!.tokenId
  server = await db().mcpServer.findUniqueOrThrow({
    where: { id: (await createBrowserServer(ctx)).id },
  })
  elsewhere = await startTestApi((_, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end("<title>Elsewhere</title><h1>Elsewhere</h1>")
  })
  api = await startTestApi((request, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")
    const port = new URL(api.origin).port

    // A page that opens windows on its own, without a click (Playwright's
    // Chromium blocks no popups): elsewhere directly, without an opener,
    // through a redirect, after starting blank, and from a frame; then one
    // on this site, which may open.
    if (request.url.startsWith("/popups")) {
      return res.end(`<!doctype html><title>Popups</title><h1>Popups</h1>
<iframe src="/frame"></iframe>
<script>
window.open("${elsewhere.origin}/direct")
window.open("${elsewhere.origin}/no-opener", "_blank", "noopener")
window.open("/redirect")
window.open().location = "${elsewhere.origin}/later"
setTimeout(() => window.open("/page"), 300)
</script>`)
    }

    if (request.url.startsWith("/frame")) {
      return res.end(
        `<script>window.open("${elsewhere.origin}/from-frame")</script>`,
      )
    }

    if (request.url.startsWith("/redirect")) {
      res.statusCode = 302
      res.setHeader("location", `${elsewhere.origin}/redirected`)
      return res.end()
    }

    if (request.url.startsWith("/form")) {
      return res.end(
        FORM.replace("__ELSEWHERE__", `http://localhost:${port}/page`),
      )
    }

    if (request.url.startsWith("/cookie")) {
      return res.end(
        `<title>Cookie</title><h1>cookie: ${request.headers.cookie ?? "none"}</h1>`,
      )
    }

    if (request.url.startsWith("/walled-forever")) {
      return answerWalled(request, res, { clears: false })
    }

    if (request.url.startsWith("/walled")) {
      return answerWalled(request, res)
    }

    if (request.url.startsWith("/fingerprint")) {
      return res.end(FINGERPRINT)
    }

    if (request.url.startsWith("/doors")) {
      return res.end(DOORS)
    }

    res.end("<title>Page</title><h1>A page</h1>")
  })
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await elsewhere.close()
  await cleanup()
})

afterAll(async () => {
  await closeAllBrowsers()
})

function call(name: string, args: Record<string, unknown> = {}) {
  return callBrowserTool(ctx, server, name, args, {
    tokenId,
    publicUrl: PUBLIC_URL,
  })
}

/** A second token, which reaches the browser too. */
async function otherToken() {
  const { token } = await createApiToken(ctx, {
    name: "Other",
    allowAllServers: true,
  })
  const other = (await resolveApiToken(token))!.tokenId

  return {
    tokenId: other,
    call: (name: string, args: Record<string, unknown> = {}) =>
      callBrowserTool(ctx, server, name, args, {
        tokenId: other,
        publicUrl: PUBLIC_URL,
      }),
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function refOf(result: CallToolResult, pattern: RegExp): string {
  const line = textOf(result)
    .split("\n")
    .find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]

  if (!ref) {
    throw new Error(`no ref for ${pattern} in:\n${textOf(result)}`)
  }

  return ref
}

async function owner(promise: Promise<unknown>): Promise<OwnerNeeded> {
  try {
    await promise
  } catch (error) {
    if (isOwnerNeeded(error)) return error
    throw error
  }
  throw new Error("expected the owner to be asked")
}

describe.skipIf(!executable)("the browser's tools", { timeout: 90_000 }, () => {
  it("asks about a new site, refuses a private address until allowed, then opens and acts on the page", async () => {
    const host = new URL(api.origin).host

    const asked = await owner(call("navigate", { url: `${api.origin}/form` }))
    expect(asked.ask).toMatchObject({
      kind: "browse",
      input: { serverId: server.id, tabId: null, toolName: "navigate" },
    })
    // The site is on the token's page as one it tried, as web_fetch does.
    expect(
      (await listFetchRules(ctx, tokenId)).sites.map((site) => site.host),
    ).toEqual([host])
    expect(runningBrowser(ctx.vaultId)).toBeNull()

    await setFetchSite(ctx, tokenId, host, "allowed")
    const refused = await call("navigate", { url: `${api.origin}/form` })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("private or local address")
    expect(api.requests).toHaveLength(0)

    await setFetchPrivate(ctx, tokenId, "allowed")
    const opened = await call("navigate", { url: `${api.origin}/form` })
    const text = textOf(opened)
    expect(opened.isError, text).toBeUndefined()
    expect(text).toContain(`Address: ${api.origin}/form`)
    expect(text).toMatch(
      /The owner can watch it or take over at http:\/\/pcp\.test\/browser\/tabs\/\S+/,
    )
    expect(text).toContain('textbox "Name"')
    expect(api.requests[0]!.headers["user-agent"]).not.toContain("Headless")

    const typed = await call("type", {
      ref: refOf(opened, /textbox "Name"/),
      text: "Ada",
    })
    const clicked = await call("click", {
      ref: refOf(typed, /button "Say hello"/),
    })
    expect(textOf(clicked)).toContain("Hello, Ada")

    const chosen = await call("select_option", {
      ref: refOf(clicked, /combobox "Pet"/),
      values: ["cat"],
    })
    expect(textOf(chosen)).toMatch(/option "Cat" \[selected\]/)

    const found = await call("find", { text: "hello" })
    expect(textOf(found)).toMatch(/heading "Hello, Ada"/)

    const read = await call("read_page", {})
    expect(textOf(read)).toContain("# Hello, Ada")

    const picture = await call("screenshot", {})
    expect(picture.content.some((part) => part.type === "image")).toBe(true)

    const stale = await call("click", { ref: "e999" })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain("Take a new snapshot")
  })

  it("stops a link to a site the token may not open, and lists the site", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")

    const opened = await call("navigate", { url: `${api.origin}/form` })
    const followed = await call("click", {
      ref: refOf(opened, /link "Elsewhere"/),
    })
    const other = `localhost:${new URL(api.origin).port}`

    expect(textOf(followed)).toContain(`The page tried to open ${other}`)
    expect(textOf(followed)).toContain(`Address: ${api.origin}/form`)
    expect(
      (await listFetchRules(ctx, tokenId)).sites
        .map((site) => site.host)
        .sort(),
    ).toEqual([host, other].sort())
  })

  it("lets no popup ask a site the token may not open for anything", async () => {
    const host = new URL(api.origin).host
    const other = new URL(elsewhere.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")

    const opened = await call("navigate", { url: `${api.origin}/popups` })
    const parentId = textOf(opened).match(/^Tab (\S+):/m)![1]!
    const vault = runningBrowser(ctx.vaultId)!

    // The popup on the token's own site becomes a tab of the token's.
    await vi.waitFor(
      () => {
        const popup = [...vault.tabs.values()].find(
          (tab) => tab.page.url() === `${api.origin}/page`,
        )
        expect(popup?.openedBy).toBe("Claude")
      },
      { timeout: 10_000, interval: 50 },
    )
    // Long past when the others would have been asked for.
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(elsewhere.requests.map((request) => request.url)).toEqual([])
    expect(
      [...vault.tabs.values()].filter((tab) =>
        tab.page.url().startsWith(elsewhere.origin),
      ),
    ).toEqual([])
    expect(api.requests.map((request) => request.url)).toContain("/redirect")

    // The tab whose page tried says so, and the site is on the token's page.
    const snapshot = await call("snapshot", { tab: parentId })
    expect(`${textOf(opened)}\n${textOf(snapshot)}`).toContain(
      `The page tried to open ${other}`,
    )
    expect(
      (await listFetchRules(ctx, tokenId)).sites.map((site) => site.host),
    ).toContain(other)
  })

  it("keeps the sign-ins in the vault across a restart of the browser", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")

    const opened = await call("navigate", { url: `${api.origin}/form` })
    await call("click", { ref: refOf(opened, /button "Say hello"/) })
    await closeBrowser(ctx.vaultId, { ctx })
    expect(runningBrowser(ctx.vaultId)).toBeNull()
    expect(
      (await loadProfile(ctx))?.cookies.map((cookie) => cookie.name),
    ).toEqual(["seen"])

    const again = await call("navigate", { url: `${api.origin}/cookie` })
    expect(textOf(again)).toContain("cookie: seen=1")
  })

  it("hands a tab to the owner and refuses it until they are done", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")
    await call("navigate", { url: `${api.origin}/form` })

    const handed = await owner(
      call("hand_over", { message: "Please sign in." }),
    )
    expect(handed.ask).toMatchObject({
      kind: "browser_handover",
      input: {
        message: "Please sign in.",
        url: `${api.origin}/form`,
        title: "Form",
      },
    })
    const tabId = (handed.ask.input as { tabId: string }).tabId

    const refused = await call("snapshot", {})
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("check_permission")

    expect(await finishHandover(ctx, tabId)).toBe(true)
    expect(textOf(await call("snapshot", {}))).toContain(`Tab ${tabId}`)
  })

  it("opens a site the owner allowed once, for that tab while it is open", async () => {
    await setFetchPrivate(ctx, tokenId, "allowed")
    const scope = { ctx, tokenId, publicUrl: PUBLIC_URL, serverId: server.id }

    const opened = await performNavigate(
      scope,
      { tabId: null, url: `${api.origin}/form` },
      { allowedByOwner: true },
    )
    expect(textOf(opened)).toContain('textbox "Name"')

    // Another page of the same site in that tab needs no asking.
    const next = await call("navigate", { url: `${api.origin}/page` })
    expect(textOf(next)).toContain("A page")

    // A new tab does.
    await owner(call("tabs", { action: "open", url: `${api.origin}/page` }))
  })

  it("keeps a token's tabs its own: another token cannot list, read or act on them, nor fall onto them", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")
    const opened = await call("navigate", { url: `${api.origin}/form` })
    const tabId = textOf(opened).match(/^Tab (\S+):/m)![1]!
    const other = await otherToken()

    // The other token sees no tab, and A's tab answers as one that does
    // not exist: the same words, with nothing of its address or title.
    const listed = textOf(await other.call("tabs", { action: "list" }))
    expect(listed).toContain("This token has no tab open")
    expect(listed).not.toContain(tabId)
    expect(listed).not.toContain(api.origin)

    const unknown = textOf(await other.call("snapshot", { tab: "nosuchtab" }))
    for (const [name, args] of [
      ["snapshot", {}],
      ["read_page", {}],
      ["find", { text: "Name" }],
      ["screenshot", {}],
      ["click", { ref: refOf(opened, /button "Say hello"/) }],
      ["type", { ref: refOf(opened, /textbox "Name"/), text: "Mallory" }],
      ["press_key", { key: "Enter" }],
      ["scroll", { direction: "down" }],
      ["back", {}],
      ["wait_for", { ms: 1 }],
      ["handle_dialog", { action: "accept" }],
      ["hand_over", { message: "Mine now." }],
      ["tabs", { action: "select" }],
      ["tabs", { action: "close" }],
    ] as const) {
      const result = await other.call(name, { ...args, tab: tabId })
      expect(result.isError, name).toBe(true)
      expect(textOf(result), name).toBe(unknown.replace("nosuchtab", tabId))
      expect(textOf(result), name).not.toContain(api.origin)

      // Nor does a call without a tab fall onto it (tabs needs one).
      if (name !== "tabs") {
        const current = await other.call(name, args)
        expect(current.isError, name).toBe(true)
        expect(textOf(current), name).toContain("This token has no tab open")
      }
    }

    // A navigate in A's tab opens a tab of the other token's own instead.
    await setFetchSite(ctx, other.tokenId, host, "allowed")
    await setFetchPrivate(ctx, other.tokenId, "allowed")
    const elsewhere = await other.call("navigate", {
      tab: tabId,
      url: `${api.origin}/page`,
    })
    expect(textOf(elsewhere)).toContain("A page")
    expect(textOf(elsewhere)).not.toContain(`Tab ${tabId}:`)
    expect(textOf(await other.call("tabs", { action: "list" }))).not.toContain(
      tabId,
    )

    // A's tab is as A left it, and A's alone.
    const mine = textOf(await call("snapshot", {}))
    expect(mine).toContain(`Tab ${tabId}:`)
    expect(mine).toContain(`Address: ${api.origin}/form`)
    expect(mine).toContain("Who are you?")
    expect(textOf(await call("tabs", { action: "list" }))).toMatch(
      new RegExp(`^\\* ${tabId}: Form`, "m"),
    )
  })

  it("keeps a site the owner allowed once with the token whose tab it is", async () => {
    await setFetchPrivate(ctx, tokenId, "allowed")
    const scope = { ctx, tokenId, publicUrl: PUBLIC_URL, serverId: server.id }
    const opened = await performNavigate(
      scope,
      { tabId: null, url: `${api.origin}/form` },
      { allowedByOwner: true },
    )
    const tabId = textOf(opened).match(/^Tab (\S+):/m)![1]!
    const other = await otherToken()
    await setFetchPrivate(ctx, other.tokenId, "allowed")

    // Another token is asked about the site, for a tab of its own.
    const asked = await owner(
      other.call("navigate", { tab: tabId, url: `${api.origin}/page` }),
    )
    expect(asked.ask).toMatchObject({
      kind: "browse",
      input: { tabId: null, url: `${api.origin}/page` },
    })

    // And an answer that names A's tab opens a new one, not A's.
    const allowed = await performNavigate(
      { ...scope, tokenId: other.tokenId },
      { tabId, url: `${api.origin}/page` },
      { allowedByOwner: true },
    )
    expect(textOf(allowed)).toContain("A page")
    expect(textOf(allowed)).not.toContain(`Tab ${tabId}:`)
    expect(textOf(await call("snapshot", {}))).toContain(
      `Address: ${api.origin}/form`,
    )
  })

  it("leaves a page alone once the token may no longer open its site", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")
    const opened = await call("navigate", { url: `${api.origin}/form` })
    const tabId = textOf(opened).match(/^Tab (\S+):/m)![1]!

    await setFetchSite(ctx, tokenId, host, "blocked")
    for (const name of ["snapshot", "read_page", "screenshot"]) {
      const refused = await call(name, {})
      expect(refused.isError, name).toBe(true)
      expect(textOf(refused), name).toContain(
        `${host}, which this token may not open now`,
      )
      expect(textOf(refused), name).not.toContain("Who are you?")
    }

    // Closing it is still the token's to do.
    expect(
      textOf(await call("tabs", { action: "close", tab: tabId })),
    ).toContain(`Closed tab ${tabId}`)
  })

  it("never opens PCP's own address", async () => {
    const own = await call("navigate", { url: `${PUBLIC_URL}/settings` })
    expect(own.isError).toBe(true)
    expect(textOf(own)).toContain("PCP's own address")
    expect((await listFetchRules(ctx, tokenId)).sites).toEqual([])
  })

  it("waits for a site's check that passes on its own, and keeps its clearance with the sign-ins", async () => {
    await allowApi()

    const opened = await call("navigate", { url: `${api.origin}/walled` })
    const text = textOf(opened)
    expect(opened.isError, text).toBeUndefined()
    expect(text).toContain("Behind the wall")
    expect(text).not.toContain("Just a moment")
    expect(text).not.toContain(CHALLENGE_LINE)
    expect(
      (await loadProfile(ctx))?.cookies.map((cookie) => cookie.name),
    ).toContain(WALL_COOKIE)
  })

  it("says plainly when a check does not pass, and leaves the hand-over to the assistant", async () => {
    await allowApi()

    const started = Date.now()
    const stuck = await call("navigate", {
      url: `${api.origin}/walled-forever`,
    })
    const text = textOf(stuck)
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHALLENGE_WAIT_MS)
    // Not an error, and nobody asked: the call answered rather than
    // throwing for the owner.
    expect(stuck.isError, text).toBeUndefined()
    expect(text.split("\n")[0]).toBe(
      `${CHALLENGE_LINE} It did not pass on its own in this tab: call hand_over so the owner can pass it themselves, then take a snapshot.`,
    )
    expect(text).toContain(`Address: ${api.origin}/walled-forever`)

    // Every look at the tab says so while the check stays.
    for (const [name, args] of [
      ["snapshot", {}],
      ["wait_for", { ms: 1 }],
      ["read_page", {}],
    ] as const) {
      const again = await call(name, args)
      expect(again.isError, name).toBeUndefined()
      expect(textOf(again).split("\n")[0], name).toContain(CHALLENGE_LINE)
      expect(textOf(again), name).toContain("hand_over")
    }

    // The owner passes it in the hand-over the assistant chose to make.
    const handed = await owner(
      call("hand_over", { message: "Please pass the check." }),
    )
    expect(handed.ask.kind).toBe("browser_handover")
  })

  it("gives a check a link leads to its moment too, and says so after a click or back that lands on one", async () => {
    await allowApi()

    // The fake's clearance opens both of its pages, so the one that stays
    // comes first.
    const doors = await call("navigate", { url: `${api.origin}/doors` })
    const stayed = await call("click", { ref: refOf(doors, /link "Stays"/) })
    expect(stayed.isError).toBeUndefined()
    expect(textOf(stayed).split("\n")[0]).toContain(CHALLENGE_LINE)
    expect(textOf(stayed)).toContain(`Address: ${api.origin}/walled-forever`)

    await call("navigate", { url: `${api.origin}/page` })
    const back = await call("back", {})
    expect(back.isError).toBeUndefined()
    expect(textOf(back).split("\n")[0]).toContain(CHALLENGE_LINE)
    expect(textOf(back)).toContain(`Address: ${api.origin}/walled-forever`)

    const returned = await call("back", {})
    expect(textOf(returned)).not.toContain(CHALLENGE_LINE)
    const passed = await call("click", {
      ref: refOf(returned, /link "Passes"/),
    })
    expect(textOf(passed)).toContain("Behind the wall")
    expect(textOf(passed)).not.toContain(CHALLENGE_LINE)
  })

  it("shows sites a browser that says neither that it is headless nor that it is driven", async () => {
    await allowApi()

    await call("navigate", { url: `${api.origin}/fingerprint` })
    const read = textOf(await call("read_page", {}))
    const seen = JSON.parse(read.match(/```\w*\n([\s\S]*?)\n```/)![1]!) as {
      webdriver: boolean
      userAgent: string
      brands: string
      screenWidth: number
    }
    const sent = api.requests.find((request) => request.url === "/fingerprint")!

    expect(seen.webdriver).toBe(false)
    expect(seen.userAgent).toContain("Chrome/")
    expect(seen.userAgent).not.toContain("Headless")
    expect(seen.brands).toContain("Chromium")
    expect(seen.brands).not.toContain("Headless")
    expect(seen.screenWidth).toBeGreaterThan(1280)
    expect(sent.headers["user-agent"]).not.toContain("Headless")
    expect(sent.headers["sec-ch-ua"]).toContain("Chromium")
    expect(sent.headers["sec-ch-ua"]).not.toContain("Headless")
  })
})

/** The test API's site, and private addresses, for the token. */
async function allowApi(): Promise<void> {
  await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
  await setFetchPrivate(ctx, tokenId, "allowed")
}
