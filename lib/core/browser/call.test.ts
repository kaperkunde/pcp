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
import {
  callBrowserTool,
  finishHandover,
  performNavigate,
  tabHint,
} from "./call"
import { chromiumExecutable } from "./executable"
import { CHALLENGE_WAIT_MS } from "./limits"
import { loadProfile } from "./profile"
import { closeAllBrowsers, closeBrowser, runningBrowser } from "./runtime"
import { refsOf } from "./refs"
import { createBrowserServer } from "./server"
import { isOwnerNeeded, type OwnerNeeded } from "./types"

// The browser's tools against a real headless Chromium and pages served on
// this machine. Skipped where no Chromium is installed (`pnpm exec
// playwright install chromium`, or PCP_BROWSER_EXECUTABLE). A site's check
// is given a few seconds rather than twenty: the fake one passes in a third
// of a second, or never. An action on an element that never becomes
// actionable is given three seconds rather than ten: the pages here answer
// at once.

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./limits")>()),
  CHALLENGE_WAIT_MS: 3_000,
  ACTION_TIMEOUT_MS: 3_000,
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

/** A page that tries to register a service worker two ways, then says how. */
const WORKERS = `<!doctype html><title>Workers</title>
<pre><code id="seen">pending</code></pre>
<script>
const out = {}
const attempt = async (name, register) => {
  try {
    await register()
    out[name] = "registered"
  } catch {
    out[name] = "refused"
  }
}
Promise.all([
  attempt("instance", () => navigator.serviceWorker.register("/sw.js?a")),
  attempt("prototype", () =>
    ServiceWorkerContainer.prototype.register.call(
      navigator.serviceWorker,
      "/sw.js?b",
    ),
  ),
]).then(async () => {
  out.registrations = (await navigator.serviceWorker.getRegistrations()).length
  out.native = /\\[native code\\]/.test(navigator.serviceWorker.register.toString())
  document.getElementById("seen").textContent = JSON.stringify(out)
})
</script>`

/**
 * What a page's own script can tell of the browser that shows it, after a
 * word: read_page leaves out a code block that is only JSON.
 */
const FINGERPRINT = `<!doctype html><title>Fingerprint</title>
<pre><code id="seen"></code></pre>
<script>
document.getElementById("seen").textContent = "seen " + JSON.stringify({
  webdriver: navigator.webdriver,
  userAgent: navigator.userAgent,
  brands: JSON.stringify(navigator.userAgentData?.brands),
  screenWidth: screen.width,
})
</script>`

/** The state a site's app carries in its page, which it does not show. */
const STATE = JSON.stringify({
  messages: Array.from({ length: 30 }, (_, i) => ({ id: i, text: "hidden" })),
})

/**
 * A messaging page: the same words in the sidebar and the thread, an
 * element covered by another, a button that opens an alert, and what it
 * does not show (a hidden draft, its state as JSON).
 */
const INBOX = `<!doctype html><title>Inbox</title>
<nav aria-label="Conversations"><ul>
<li><a href="#ada">Ada: see you at noon</a></li>
<li><a href="#bob">Bob: see you at noon</a></li>
</ul></nav>
<main>
<h1>Ada</h1>
<section aria-label="Thread">
<p>Ada: see you at noon</p>
<button>Reply</button> <button>Reply all</button>
<label>Message <input></label>
</section>
<button onclick="alert('Saved!')">Save</button>
<div style="position: relative; width: 200px">
<button onclick="document.title = 'clicked'">Covered</button>
<div role="dialog" aria-label="Cookie consent" style="position: absolute; inset: 0; background: #0003"></div>
</div>
<p hidden>Secret draft</p>
<code style="display: none">${STATE}</code>
<pre><code>${STATE}</code></pre>
</main>
<footer>Footer words</footer>`

/**
 * A page its script draws, in shadow DOM (which the page's HTML does not
 * carry), anew on every click: each element a new one where the old was.
 */
const DRAWN = `<!doctype html><title>Drawn</title>
<div id="app"></div>
<script>
let fruit = ["apple", "pear"]
let clicks = 0
function draw() {
  const app = document.getElementById("app")
  app.replaceChildren()
  const host = document.createElement("div")
  app.append(host)
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = "<h1>Shop</h1><p>Clicked " + clicks + " times</p><ul>" +
    fruit.map((name) => "<li><button data-fruit='" + name + "'>Add " + name + "</button></li>").join("") +
    "</ul><button id='redraw'>Redraw</button><button id='drop'>Drop pear</button>"
  for (const button of root.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      clicks += 1
      if (button.id === "drop") fruit = fruit.filter((name) => name !== "pear")
      if (button.dataset.fruit) document.title = "Added " + button.dataset.fruit
      setTimeout(draw, 0)
    })
  }
}
draw()
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

    if (request.url.startsWith("/workers")) {
      return res.end(WORKERS)
    }

    if (request.url.startsWith("/sw.js")) {
      res.setHeader("content-type", "text/javascript")
      return res.end("self.addEventListener('fetch', () => {})")
    }

    if (request.url.startsWith("/doors")) {
      return res.end(DOORS)
    }

    if (request.url.startsWith("/inbox")) {
      return res.end(INBOX)
    }

    if (request.url.startsWith("/drawn")) {
      return res.end(DRAWN)
    }

    if (request.url.startsWith("/empty")) {
      return res.end("<!doctype html><title>Empty</title>")
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

/** The tab an answer is about ("Tab abc: title"). */
function tabOf(result: CallToolResult): string {
  const id = textOf(result).match(/^Tab (\S+):/m)?.[1]

  if (!id) {
    throw new Error(`no tab in:\n${textOf(result)}`)
  }

  return id
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

    const asked = await owner(
      call("tabs", { action: "open", url: `${api.origin}/form` }),
    )
    expect(asked.ask).toMatchObject({
      kind: "browse",
      input: { serverId: server.id, tabId: null, toolName: "tabs" },
    })
    // The site is on the token's page as one it tried, as web_fetch does.
    expect(
      (await listFetchRules(ctx, tokenId)).sites.map((site) => site.host),
    ).toEqual([host])
    expect(runningBrowser(ctx.vaultId)).toBeNull()

    await setFetchSite(ctx, tokenId, host, "allowed")
    const refused = await call("tabs", {
      action: "open",
      url: `${api.origin}/form`,
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("private or local address")
    expect(api.requests).toHaveLength(0)
    // The tab opened all the same, and its id comes first.
    const tab = tabOf(refused)
    expect(textOf(refused).split("\n")[0]).toBe(
      `Opened a new tab: ${tab}. Name ${tab} as tab in the calls that follow.`,
    )

    await setFetchPrivate(ctx, tokenId, "allowed")
    const opened = await call("navigate", { tab, url: `${api.origin}/form` })
    const text = textOf(opened)
    expect(opened.isError, text).toBeUndefined()
    expect(text).toContain(`Address: ${api.origin}/form`)
    expect(text).toMatch(
      /The owner can watch it or take over at http:\/\/pcp\.test\/browser\?tab=\S+/,
    )
    expect(text).toContain('textbox "Name"')
    expect(api.requests[0]!.headers["user-agent"]).not.toContain("Headless")

    const typed = await call("type", {
      tab,
      ref: refOf(opened, /textbox "Name"/),
      text: "Ada",
    })
    const clicked = await call("click", {
      tab,
      ref: refOf(typed, /button "Say hello"/),
    })
    expect(textOf(clicked)).toContain("Hello, Ada")

    const chosen = await call("select_option", {
      tab,
      ref: refOf(clicked, /combobox "Pet"/),
      values: ["cat"],
    })
    expect(textOf(chosen)).toMatch(/option "Cat" \[selected\]/)

    const found = JSON.parse(
      textOf(await call("find", { tab, text: "hello" })),
    ) as { tab: string; matches: Array<{ role: string; name?: string }> }
    expect(found.tab).toBe(tab)
    expect(found.matches).toContainEqual(
      expect.objectContaining({ role: "heading", name: "Hello, Ada" }),
    )

    const read = await call("read_page", { tab })
    expect(textOf(read)).toContain("# Hello, Ada")

    const picture = await call("screenshot", { tab })
    expect(picture.content.some((part) => part.type === "image")).toBe(true)

    const stale = await call("click", { tab, ref: "e999" })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain(
      "There is no element e999 on this tab's page: refs come from this tab's snapshots (and find). Take a snapshot",
    )
  })

  it("stops a link to a site the token may not open, and lists the site", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")

    const opened = await call("tabs", {
      action: "open",
      url: `${api.origin}/form`,
    })
    const followed = await call("click", {
      tab: tabOf(opened),
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

    const opened = await call("tabs", {
      action: "open",
      url: `${api.origin}/popups`,
    })
    const parentId = tabOf(opened)
    const vault = runningBrowser(ctx.vaultId)!

    // The popup on the token's own site becomes a tab of the token's.
    let popupId = ""
    await vi.waitFor(
      () => {
        const popup = [...vault.tabs.values()].find(
          (tab) => tab.page.url() === `${api.origin}/page`,
        )
        expect(popup?.openedBy).toBe("Claude")
        popupId = popup!.id
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
    // The popup is named as a new tab; it is not the one the answer is about.
    expect(`${textOf(opened)}\n${textOf(snapshot)}`).toContain(
      `The page opened a new tab, ${popupId} (${api.origin}/page).`,
    )
    expect(tabOf(snapshot)).toBe(parentId)
    expect(
      (await listFetchRules(ctx, tokenId)).sites.map((site) => site.host),
    ).toContain(other)
  })

  it("keeps the sign-ins in the vault across a restart of the browser", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")

    const opened = await call("tabs", {
      action: "open",
      url: `${api.origin}/form`,
    })
    await call("click", {
      tab: tabOf(opened),
      ref: refOf(opened, /button "Say hello"/),
    })
    await closeBrowser(ctx.vaultId, { ctx })
    expect(runningBrowser(ctx.vaultId)).toBeNull()
    expect(
      (await loadProfile(ctx))?.cookies.map((cookie) => cookie.name),
    ).toEqual(["seen"])

    // The tab went with the browser: naming it opens a new one.
    const again = await call("navigate", {
      tab: tabOf(opened),
      url: `${api.origin}/cookie`,
    })
    expect(textOf(again)).toContain("cookie: seen=1")
    expect(textOf(again).split("\n")[0]).toContain(
      `There is no tab ${tabOf(opened)}`,
    )
  })

  it("hands a tab to the owner and refuses it until they are done", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")
    const tab = tabOf(
      await call("tabs", { action: "open", url: `${api.origin}/form` }),
    )

    const handed = await owner(
      call("hand_over", { tab, message: "Please sign in." }),
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

    expect(tabId).toBe(tab)
    const refused = await call("snapshot", { tab })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("check_permission")

    expect(await finishHandover(ctx, tabId)).toBe(true)
    expect(textOf(await call("snapshot", { tab }))).toContain(`Tab ${tabId}`)
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
    const next = await call("navigate", {
      tab: tabOf(opened),
      url: `${api.origin}/page`,
    })
    expect(textOf(next)).toContain("A page")

    // A new tab does.
    await owner(call("tabs", { action: "open", url: `${api.origin}/page` }))
  })

  it("keeps a token's tabs its own: another token cannot list, read or act on them, nor fall onto them", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")
    const opened = await call("tabs", {
      action: "open",
      url: `${api.origin}/form`,
    })
    const tabId = tabOf(opened)
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
      ["tabs", { action: "reset" }],
      ["tabs", { action: "close" }],
    ] as const) {
      const result = await other.call(name, { ...args, tab: tabId })
      expect(result.isError, name).toBe(true)
      expect(textOf(result), name).toBe(unknown.replace("nosuchtab", tabId))
      expect(textOf(result), name).not.toContain(api.origin)

      // Nor does a call without a tab fall onto it: it names none.
      const current = await other.call(name, args)
      expect(current.isError, name).toBe(true)
      expect(textOf(current), name).toContain(
        "needs the tab to act on (tab), and the browser never picks one",
      )
      expect(textOf(current), name).toContain("This token has no tab open")
      expect(textOf(current), name).not.toContain(tabId)
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
    const mine = textOf(await call("snapshot", { tab: tabId }))
    expect(mine).toContain(`Tab ${tabId}:`)
    expect(mine).toContain(`Address: ${api.origin}/form`)
    expect(mine).toContain("Who are you?")
    expect(textOf(await call("tabs", { action: "list" }))).toMatch(
      new RegExp(`^- ${tabId}: Form · ${api.origin}/form`, "m"),
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
    const tabId = tabOf(opened)
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
    expect(textOf(await call("snapshot", { tab: tabId }))).toContain(
      `Address: ${api.origin}/form`,
    )
  })

  it("leaves a page alone once the token may no longer open its site", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, tokenId, host, "allowed")
    await setFetchPrivate(ctx, tokenId, "allowed")
    const opened = await call("tabs", {
      action: "open",
      url: `${api.origin}/form`,
    })
    const tabId = tabOf(opened)

    await setFetchSite(ctx, tokenId, host, "blocked")
    for (const name of ["snapshot", "read_page", "screenshot"]) {
      const refused = await call(name, { tab: tabId })
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
    const own = await call("tabs", {
      action: "open",
      url: `${PUBLIC_URL}/settings`,
    })
    expect(own.isError).toBe(true)
    expect(textOf(own)).toContain("PCP's own address")
    expect((await listFetchRules(ctx, tokenId)).sites).toEqual([])
  })

  it("waits for a site's check that passes on its own, and keeps its clearance with the sign-ins", async () => {
    await allowApi()

    const opened = await call("tabs", {
      action: "open",
      url: `${api.origin}/walled`,
    })
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
    const stuck = await call("tabs", {
      action: "open",
      url: `${api.origin}/walled-forever`,
    })
    const text = textOf(stuck)
    const tab = tabOf(stuck)
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHALLENGE_WAIT_MS)
    // Not an error, and nobody asked: the call answered rather than
    // throwing for the owner.
    expect(stuck.isError, text).toBeUndefined()
    // After the new tab's id, which comes first.
    expect(text.split("\n")[1]).toBe(
      `${CHALLENGE_LINE} It did not pass on its own in this tab: call hand_over so the owner can pass it themselves, then take a snapshot.`,
    )
    expect(text).toContain(`Address: ${api.origin}/walled-forever`)

    // Every look at the tab says so while the check stays.
    for (const [name, args] of [
      ["snapshot", {}],
      ["wait_for", { ms: 1 }],
      ["read_page", {}],
    ] as const) {
      const again = await call(name, { ...args, tab })
      expect(again.isError, name).toBeUndefined()
      expect(textOf(again).split("\n")[0], name).toContain(CHALLENGE_LINE)
      expect(textOf(again), name).toContain("hand_over")
    }

    // The owner passes it in the hand-over the assistant chose to make.
    const handed = await owner(
      call("hand_over", { tab, message: "Please pass the check." }),
    )
    expect(handed.ask.kind).toBe("browser_handover")
  })

  it("gives a check a link leads to its moment too, and says so after a click or back that lands on one", async () => {
    await allowApi()

    // The fake's clearance opens both of its pages, so the one that stays
    // comes first.
    const doors = await call("tabs", {
      action: "open",
      url: `${api.origin}/doors`,
    })
    const tab = tabOf(doors)
    const stayed = await call("click", {
      tab,
      ref: refOf(doors, /link "Stays"/),
    })
    expect(stayed.isError).toBeUndefined()
    expect(textOf(stayed).split("\n")[0]).toContain(CHALLENGE_LINE)
    expect(textOf(stayed)).toContain(`Address: ${api.origin}/walled-forever`)

    await call("navigate", { tab, url: `${api.origin}/page` })
    const back = await call("back", { tab })
    expect(back.isError).toBeUndefined()
    expect(textOf(back).split("\n")[0]).toContain(CHALLENGE_LINE)
    expect(textOf(back)).toContain(`Address: ${api.origin}/walled-forever`)

    const returned = await call("back", { tab })
    expect(textOf(returned)).not.toContain(CHALLENGE_LINE)
    const passed = await call("click", {
      tab,
      ref: refOf(returned, /link "Passes"/),
    })
    expect(textOf(passed)).toContain("Behind the wall")
    expect(textOf(passed)).not.toContain(CHALLENGE_LINE)
  })

  it("shows sites a browser that says neither that it is headless nor that it is driven", async () => {
    await allowApi()

    const tab = tabOf(
      await call("tabs", { action: "open", url: `${api.origin}/fingerprint` }),
    )
    const read = textOf(await call("read_page", { tab }))
    const seen = JSON.parse(read.match(/```\w*\nseen (.*?)\n```/)![1]!) as {
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

  it("refuses a service worker at the gate and leaves the page's own functions alone", async () => {
    await allowApi()

    const tab = tabOf(
      await call("tabs", { action: "open", url: `${api.origin}/workers` }),
    )

    let seen: Record<string, unknown> = {}
    await vi.waitFor(
      async () => {
        const read = textOf(await call("read_page", { tab }))
        expect(read).not.toContain("pending")
        seen = JSON.parse(read.match(/```\w*\n([\s\S]*?)\n```/)![1]!)
      },
      { timeout: 10_000 },
    )

    // Through the instance and through the prototype, which a script that
    // replaced navigator.serviceWorker.register would not stop.
    expect(seen).toEqual({
      instance: "refused",
      prototype: "refused",
      registrations: 0,
      native: true,
    })
    // Nothing reached the network: the gate failed the request.
    expect(
      api.requests.some((request) => request.headers["service-worker"]),
    ).toBe(false)
  })
})

describe.skipIf(!executable)(
  "reading and acting on a page",
  { timeout: 90_000 },
  () => {
    async function inbox(): Promise<{ tab: string; opened: CallToolResult }> {
      await allowApi()
      const opened = await call("tabs", {
        action: "open",
        url: `${api.origin}/inbox`,
      })
      return { tab: tabOf(opened), opened }
    }

    it("refuses a call that names no tab, as a tool error listing the token's tabs", async () => {
      const { tab } = await inbox()

      for (const [name, args] of [
        ["snapshot", {}],
        ["navigate", { url: `${api.origin}/page` }],
        ["tabs", { action: "close" }],
        ["hand_over", { message: "Please." }],
      ] as const) {
        const refused = await call(name, args)
        expect(refused.isError, name).toBe(true)
        expect(textOf(refused), name).toContain(
          `${name} needs the tab to act on (tab)`,
        )
        expect(textOf(refused), name).toMatch(
          new RegExp(`^- ${tab}: Inbox · ${api.origin}/inbox · `, "m"),
        )
      }

      // Nothing was opened in the meantime.
      expect(runningBrowser(ctx.vaultId)!.tabs.size).toBe(1)
    })

    it("finds elements as JSON, with the part of the page that tells the same words apart, and within one part", async () => {
      const { tab, opened } = await inbox()
      const found = JSON.parse(
        textOf(await call("find", { tab, text: "see you at noon" })),
      ) as {
        total: number
        matches: Array<{
          role: string
          name?: string
          ref?: string
          landmark?: { role: string; name?: string; ref?: string }
        }>
      }

      expect(found.total).toBe(3)
      expect(
        found.matches.map((match) => [match.role, match.landmark]),
      ).toEqual([
        [
          "link",
          expect.objectContaining({
            role: "navigation",
            name: "Conversations",
          }),
        ],
        [
          "link",
          expect.objectContaining({
            role: "navigation",
            name: "Conversations",
          }),
        ],
        [
          "paragraph",
          expect.objectContaining({ role: "region", name: "Thread" }),
        ],
      ])

      const thread = refOf(opened, /region "Thread"/)
      const within = JSON.parse(
        textOf(
          await call("find", { tab, text: "see you at noon", within: thread }),
        ),
      ) as { total: number; matches: Array<{ role: string }> }
      expect(within.total).toBe(1)
      expect(within.matches[0]!.role).toBe("paragraph")

      const stale = await call("find", { tab, text: "x", within: "e999" })
      expect(stale.isError).toBe(true)
      expect(textOf(stale)).toContain("There is no element e999")
    })

    it("acts on an element by its role and name, and refuses a target that is none or several", async () => {
      const { tab, opened } = await inbox()

      const typed = await call("type", {
        tab,
        target: { role: "textbox", name: "Message" },
        text: "On my way",
      })
      expect(typed.isError, textOf(typed)).toBeUndefined()
      expect(textOf(typed)).toMatch(/textbox "Message"[^\n]*: On my way/)

      // The second of two links that read alike.
      const bob = await call("click", {
        tab,
        target: { role: "link", name: "see you at noon", nth: 1 },
      })
      expect(textOf(bob)).toContain(`Address: ${api.origin}/inbox#bob`)

      const several = await call("click", {
        tab,
        target: { role: "button", name: "Reply" },
      })
      expect(several.isError).toBe(true)
      expect(textOf(several)).toContain(
        '2 elements match button named "Reply". Say which: nth',
      )
      expect(textOf(several)).toContain('"name":"Reply all"')
      expect(textOf(several)).toMatch(/"ref":"e\d+"/)

      const exact = await call("click", {
        tab,
        target: { role: "button", name: "Reply", exact: true },
      })
      expect(exact.isError, textOf(exact)).toBeUndefined()

      const none = await call("click", {
        tab,
        target: { role: "button", name: "Delete everything" },
      })
      expect(none.isError).toBe(true)
      expect(textOf(none)).toContain(
        'There is no button named "Delete everything" on the page. The button elements it has',
      )
      expect(textOf(none)).toContain('"name":"Save"')

      const tooFar = await call("click", {
        tab,
        target: { role: "button", name: "Reply", nth: 5 },
      })
      expect(textOf(tooFar)).toContain("Only 2 elements match")

      // Inside one part of the page only.
      const thread = refOf(opened, /region "Thread"/)
      const outside = await call("click", {
        tab,
        target: { role: "link", name: "see you at noon", within: thread },
      })
      expect(outside.isError).toBe(true)
      expect(textOf(outside)).toContain(
        `There is no link named "see you at noon" inside ${thread}`,
      )
    })

    it("says why a click did not happen: what covers the element, with a short snapshot", async () => {
      const { tab, opened } = await inbox()
      const started = Date.now()
      const covered = await call("click", {
        tab,
        ref: refOf(opened, /button "Covered"/),
      })
      const text = textOf(covered)

      expect(covered.isError).toBe(true)
      expect(text).toContain("The click on e")
      expect(text).toContain(
        'did not happen: Another element covers it and would get the click: a dialog (<div>) "Cookie consent".',
      )
      expect(text).toContain("force: true")
      // The covering element's ref, from the snapshot that comes with it.
      const over = text.match(
        /What covers it is the dialog "Cookie consent" \(ref (e\d+)\): close or dismiss it first/,
      )
      expect(over, text).toBeTruthy()
      expect(text).toContain(`dialog "Cookie consent" [ref=${over![1]}]`)
      expect(text).toContain("Snapshot:")
      expect(text.length).toBeLessThan(6_000)
      // Within the action's own time, not the tab's deadline.
      expect(Date.now() - started).toBeLessThan(20_000)
      expect(
        await runningBrowser(ctx.vaultId)!.tabs.get(tab)!.page.title(),
      ).toBe("Inbox")
    })

    it("answers at once while the page shows an alert, and says how to answer it", async () => {
      const { tab, opened } = await inbox()
      const saved = await call("click", {
        tab,
        ref: refOf(opened, /button "Save"/),
      })
      expect(textOf(saved)).toContain(
        `Tab ${tab} shows an alert: "Saved!". Nothing else on the page responds until it is answered: call handle_dialog`,
      )

      const started = Date.now()
      for (const [name, args] of [
        ["find", { text: "Ada" }],
        ["read_page", {}],
        ["click", { ref: refOf(opened, /button "Reply all"/) }],
        ["type", { target: { role: "textbox", name: "Message" }, text: "x" }],
        ["press_key", { key: "Enter" }],
        ["scroll", { direction: "down" }],
        ["wait_for", { text: "Never there" }],
        ["select_option", { ref: "e1", values: ["x"] }],
        ["download", { ref: "e1" }],
        ["back", {}],
        ["navigate", { url: `${api.origin}/page` }],
      ] as const) {
        const refused = await call(name, { ...args, tab })
        expect(refused.isError, name).toBe(true)
        expect(textOf(refused), name).toContain(`Tab ${tab} shows an alert`)
        expect(textOf(refused), name).toContain(`${name} was not done.`)
      }
      expect(Date.now() - started).toBeLessThan(10_000)

      // A snapshot and a screenshot say so too, without a picture.
      expect(textOf(await call("snapshot", { tab }))).toContain(
        "shows an alert",
      )
      const picture = await call("screenshot", { tab })
      expect(picture.content.map((part) => part.type)).toEqual(["text"])

      const answered = await call("handle_dialog", { tab, action: "accept" })
      expect(textOf(answered)).not.toContain("shows an alert")
      expect(textOf(answered)).toContain("Snapshot:")
    })

    it("reads the page without what it does not show, the main part alone, or one element", async () => {
      const { tab, opened } = await inbox()

      const read = textOf(await call("read_page", { tab }))
      expect(read).toContain("# Ada")
      expect(read).toContain("Footer words")
      expect(read).not.toContain("Secret draft")
      expect(read).not.toContain('"hidden"')
      expect(read).toContain(
        "Left out: 2 elements the page's HTML marks hidden, and 1 block of JSON data the page carries",
      )

      const main = textOf(await call("read_page", { tab, main_only: true }))
      expect(main).toContain("Only the page's main part, as asked.")
      expect(main).toContain("# Ada")
      expect(main).not.toContain("Footer words")

      const thread = textOf(
        await call("read_page", { tab, ref: refOf(opened, /region "Thread"/) }),
      )
      expect(thread).toContain("Ada: see you at noon")
      expect(thread).not.toContain("# Ada")
      expect(thread).not.toContain("Bob")

      const byTarget = textOf(
        await call("read_page", {
          tab,
          target: { role: "navigation", name: "Conversations" },
        }),
      )
      expect(byTarget).toContain("Bob: see you at noon")
    })

    it("keeps a ref while its element is on the page, through find and a page drawn anew, and says when it has gone", async () => {
      await allowApi()
      const opened = await call("tabs", {
        action: "open",
        url: `${api.origin}/drawn`,
      })
      const tab = tabOf(opened)
      const pear = refOf(opened, /button "Add pear"/)
      const apple = refOf(opened, /button "Add apple"/)
      const playwrights = () =>
        refsOf(runningBrowser(ctx.vaultId)!.tabs.get(tab)!).playwrightRef(pear)
      const drawnFirst = playwrights()

      // find answers with the page's refs and changes none of them.
      const found = JSON.parse(
        textOf(await call("find", { tab, query: "pear" })),
      ) as { matches: Array<{ name?: string; ref?: string }> }
      expect(found.matches).toContainEqual(
        expect.objectContaining({ name: "Add pear", ref: pear }),
      )
      expect(refOf(await call("snapshot", { tab }), /button "Add pear"/)).toBe(
        pear,
      )

      // A click draws the page anew: every element is a new one, and the
      // refs are what they were.
      const redrawn = await call("click", {
        tab,
        target: { role: "button", name: "Redraw" },
      })
      expect(textOf(redrawn)).toContain("Clicked 1 times")
      expect(refOf(redrawn, /button "Add pear"/)).toBe(pear)
      expect(refOf(redrawn, /button "Add apple"/)).toBe(apple)
      // Playwright's own ref for it is a new one.
      expect(playwrights()).not.toBe(drawnFirst)

      // Redrawn again without a snapshot in between: the old ref still
      // reaches the element where it is now.
      await call("click", { tab, target: { role: "button", name: "Redraw" } })
      const added = await call("click", { tab, ref: pear })
      expect(added.isError, textOf(added)).toBeUndefined()
      expect(textOf(added)).toContain("Tab ")
      expect(
        await runningBrowser(ctx.vaultId)!.tabs.get(tab)!.page.title(),
      ).toBe("Added pear")

      // An element that has gone says so; one the tab never gave too.
      const dropped = await call("click", {
        tab,
        target: { role: "button", name: "Drop pear" },
      })
      expect(textOf(dropped)).not.toContain("Add pear")
      expect(refOf(dropped, /button "Add apple"/)).toBe(apple)
      const gone = await call("click", { tab, ref: pear })
      expect(gone.isError).toBe(true)
      expect(textOf(gone)).toContain(
        `The element ${pear} is no longer on the page, or no longer where it can be acted on`,
      )
      const never = await call("click", { tab, ref: "e99999" })
      expect(textOf(never)).toContain(
        "There is no element e99999 on this tab's page",
      )
    })

    it("takes query for find's text, and refuses both with different values", async () => {
      const { tab } = await inbox()

      const found = JSON.parse(
        textOf(await call("find", { tab, query: "Reply" })),
      ) as { total: number }
      expect(found.total).toBe(2)
      const both = await call("find", { tab, query: "Reply", text: "Save" })
      expect(both.isError).toBe(true)
      expect(textOf(both)).toContain(
        "query is another name for text; give one of them.",
      )
    })

    it("reads a page its script draws from its snapshot, and says when a page has no text", async () => {
      await allowApi()
      const tab = tabOf(
        await call("tabs", { action: "open", url: `${api.origin}/drawn` }),
      )
      const before = refOf(await call("snapshot", { tab }), /button "Add pear"/)

      const read = textOf(await call("read_page", { tab }))
      expect(read).toContain(
        "The page's HTML holds next to no text (a page its scripts draw, in shadow DOM or in frames), so this is the text of its accessibility snapshot instead",
      )
      expect(read).toContain("# Shop")
      expect(read).toContain("Clicked 0 times")
      expect(read).toContain("Add pear")
      expect(read).not.toContain("[ref=")
      expect(read).not.toContain("Characters 0 to 0 of 0")
      // Reading took a snapshot, and changed no ref.
      expect(refOf(await call("snapshot", { tab }), /button "Add pear"/)).toBe(
        before,
      )

      await call("navigate", { tab, url: `${api.origin}/empty` })
      const empty = await call("read_page", { tab })
      expect(empty.isError).toBeUndefined()
      expect(textOf(empty)).toContain("\n\n(no text)\n")
      expect(textOf(empty)).not.toContain("Characters")

      const past = await call("read_page", { tab, start_index: 5 })
      expect(textOf(past)).toContain("(no text)")
    })

    it("lists the token's tabs, the one used last first, when a call names none or one it does not have", async () => {
      const { tab: first } = await inbox()
      const second = tabOf(
        await call("tabs", { action: "open", url: `${api.origin}/page` }),
      )
      await call("snapshot", { tab: first })

      const order = (text: string) =>
        [...text.matchAll(/^- (\S+): /gm)].map((match) => match[1])

      const unknown = await call("snapshot", { tab: "nosuchtab" })
      expect(unknown.isError).toBe(true)
      expect(textOf(unknown)).toContain("There is no tab nosuchtab")
      expect(textOf(unknown)).toContain(
        "This token's open tabs, the one used last first:",
      )
      expect(order(textOf(unknown))).toEqual([first, second])

      const missing = await call("click", { ref: "e1" })
      expect(order(textOf(missing))).toEqual([first, second])

      await call("snapshot", { tab: second })
      expect(order(await tabHint(ctx, tokenId, PUBLIC_URL))).toEqual([
        second,
        first,
      ])
      expect(await tabHint(ctx, tokenId, PUBLIC_URL)).toContain(
        `${PUBLIC_URL}/browser?tab=${second}`,
      )

      // Another token's tabs are none of this one's.
      const other = await otherToken()
      expect(await tabHint(ctx, other.tokenId, PUBLIC_URL)).toContain(
        "This token has no tab open",
      )
    })

    it("hands a screenshot back no wider than asked, and of one element", async () => {
      const { tab } = await inbox()

      const small = await call("screenshot", { tab, max_width: 400 })
      expect(textOf(small)).toContain("400 by 250, made smaller to pass on")
      const image = small.content.find((part) => part.type === "image")
      expect(image).toBeTruthy()

      const thread = await call("screenshot", {
        tab,
        target: { role: "region", name: "Thread" },
      })
      const size = textOf(thread).match(/(\d+) by (\d+)/)!
      expect(Number(size[1])).toBeLessThan(1280)
      expect(Number(size[2])).toBeLessThan(800)
      expect(textOf(thread)).toContain('the region "Thread"')
    })
  },
)

/** The test API's site, and private addresses, for the token. */
async function allowApi(): Promise<void> {
  await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
  await setFetchPrivate(ctx, tokenId, "allowed")
}
