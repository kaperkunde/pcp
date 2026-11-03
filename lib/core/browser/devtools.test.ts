import http from "node:http"
import type { AddressInfo } from "node:net"

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
import {
  allowScriptOnce,
  decideScript,
  writeScriptAccess,
} from "../browser-scripts"
import type { VaultContext } from "../context"
import { db } from "../db"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import type { KeptResult } from "../tool-results"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { callBrowserTool } from "./call"
import { maskUrl, safeHeaders } from "./devtools"
import { chromiumExecutable } from "./executable"
import { holdSecret, maskTyped, typedInto } from "./held"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"
import { isOwnerNeeded, type OwnerNeeded } from "./types"

// What #56 added to the browser: a point clicked, scrolled and dragged
// with DevTools mouse events, evaluate (asked per site, kept at its site
// while it runs), and the tab's console and network logs without
// credentials. Against a real headless Chromium, skipped where none is
// installed, as call.test.ts is.

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./limits")>()),
  ACTION_TIMEOUT_MS: 3_000,
  EVALUATE_TIMEOUT_MS: 2_000,
  EVALUATE_INLINE_CHARS: 1_000,
}))

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"

let cleanup: () => Promise<void>
let api: TestApi
let elsewhere: TestApi
let sockets: { origin: string; upgrades: string[]; close: () => void }
let ctx: VaultContext
let tokenId: string
let server: McpServer
let kept: Array<{ text?: string; bytes?: Buffer; name?: string | null }>

/** A page that draws on a canvas and says where the mouse did what. */
const CANVAS = `<!doctype html><title>Canvas</title>
<style>body { margin: 0 } canvas { display: block }</style>
<canvas id="c" width="1000" height="600"></canvas>
<script>
const seen = []
const say = (what, e) => { seen.push(what + " " + e.clientX + "," + e.clientY + (e.button ? " b" + e.button : "")); document.title = seen.slice(-3).join(" | ") }
const c = document.getElementById("c")
c.addEventListener("click", (e) => say("click", e))
c.addEventListener("dblclick", (e) => say("dbl", e))
c.addEventListener("contextmenu", (e) => { e.preventDefault(); say("menu", e) })
c.addEventListener("mousedown", (e) => say("down", e))
c.addEventListener("mouseup", (e) => say("up", e))
c.addEventListener("wheel", (e) => { e.preventDefault(); say("wheel" + Math.sign(e.deltaY), e) }, { passive: false })
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
  kept = []
  elsewhere = await startTestApi((_, res) => res.end("elsewhere"))
  const upgrades: string[] = []
  const wsServer = http.createServer((_, res) => res.end())
  wsServer.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "")
    socket.destroy()
  })
  await new Promise<void>((resolve) => wsServer.listen(0, "127.0.0.1", resolve))
  sockets = {
    origin: `127.0.0.1:${(wsServer.address() as AddressInfo).port}`,
    upgrades,
    close: () => wsServer.close(),
  }
  api = await startTestApi((request, res) => {
    if (request.url.startsWith("/canvas")) {
      res.setHeader("content-type", "text/html")
      return res.end(CANVAS)
    }

    if (request.url.startsWith("/api")) {
      res.setHeader("content-type", "application/json")
      res.setHeader("set-cookie", "session=s3cr3t; HttpOnly")
      res.setHeader("x-api-key", "k3y")
      return res.end(JSON.stringify({ ok: true, echo: request.body }))
    }

    if (request.url.startsWith("/app")) {
      res.setHeader("content-type", "text/html")
      return res.end(`<!doctype html><title>App</title>
<input id="field" aria-label="Field">
<img src="/missing.png">
<script>
window.appState = { user: "ada", items: [1, 2, 3] }
fetch("/api/items?token=abc&page=2", {
  method: "POST",
  headers: { Authorization: "Bearer t0ken", "X-Csrf-Token": "c", "Content-Type": "application/json" },
  body: JSON.stringify({ q: "plain" }),
})
</script>`)
    }

    if (request.url.startsWith("/missing")) {
      res.statusCode = 404
      return res.end()
    }

    res.setHeader("content-type", "text/html")
    res.end("<title>Page</title><h1>A page</h1>")
  })
  await setFetchPrivate(ctx, tokenId, "allowed")
  await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await elsewhere.close()
  sockets.close()
  await cleanup()
})

afterAll(async () => {
  await closeAllBrowsers()
})

function call(name: string, args: Record<string, unknown> = {}) {
  return callBrowserTool(ctx, server, name, args, {
    tokenId,
    publicUrl: PUBLIC_URL,
    keep: async (input) => {
      kept.push({ text: input.text, name: input.name })
      return fakeKept("text", input.text.length)
    },
    keepBytes: async (input) => {
      kept.push({ bytes: input.bytes, name: input.name })
      return fakeKept("bytes", input.bytes.length)
    },
  })
}

function fakeKept(kind: "text" | "bytes", length: number): KeptResult {
  return {
    id: `r${kept.length}`,
    kind,
    mediaType: "text/plain",
    name: null,
    length,
    expiresAt: new Date(Date.now() + 60_000),
    dropped: 0,
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function tabOf(result: CallToolResult): string {
  const id = textOf(result).match(/^Tab (\S+):/m)?.[1]
  if (!id) throw new Error(`no tab in:\n${textOf(result)}`)
  return id
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

async function open(path: string): Promise<string> {
  const opened = await call("tabs", {
    action: "open",
    url: `${api.origin}${path}`,
  })
  expect(opened.isError, textOf(opened)).toBeUndefined()
  return tabOf(opened)
}

async function title(tab: string): Promise<string> {
  return runningBrowser(ctx.vaultId)!.tabs.get(tab)!.page.title()
}

describe("a secret PCP typed into a page, repeated later", () => {
  it("is masked wherever a word of a log or a result is it", () => {
    const page = {} as Parameters<typeof maskTyped>[0]
    expect(typedInto(page)).toBe(false)
    expect(maskTyped(page, "nothing typed")).toBe("nothing typed")

    holdSecret(page, "Shop", "p@ss=w0rd&x")
    expect(typedInto(page)).toBe(true)
    expect(maskTyped(page, "login p@ss=w0rd&x ok")).toBe(
      "login [secret: Shop] ok",
    )
    expect(maskTyped(page, "user=ada&password=p%40ss%3Dw0rd%26x")).toBe(
      "user=ada&password=[secret: Shop]",
    )
    expect(maskTyped(page, '{"pw":"p@ss=w0rd&x"}')).toBe(
      '{"pw":"[secret: Shop]"}',
    )
    expect(maskTyped(page, "p@ss")).toBe("p@ss")
  })
})

describe("what the logs show of a request", () => {
  it("leaves out every header that carries a credential", () => {
    expect(
      safeHeaders({
        Cookie: "a=1",
        "Set-Cookie": "b=2",
        Authorization: "Bearer x",
        "Proxy-Authorization": "Basic y",
        "X-Api-Key": "k",
        "X-CSRF-Token": "t",
        "X-Session-Id": "s",
        "Client-Secret": "c",
        "Content-Type": "text/html",
        Referer: "https://a.example/?access_token=abcdef",
      }),
    ).toEqual({
      "content-type": "text/html",
      referer: "https://a.example/?access_token=%5Bmasked%5D",
    })
  })

  it("masks values in an address that look like credentials", () => {
    expect(
      maskUrl(
        "https://ada:pw@a.example/p?token=abc&page=2&id=Zx81kQp02LmNnq77aBcD9#access_token=xyz&x=1",
      ),
    ).toBe(
      "https://a.example/p?token=%5Bmasked%5D&page=2&id=%5Bmasked%5D#access_token=%5Bmasked%5D&x=1",
    )
    expect(maskUrl("https://a.example/a?q=cats")).toBe(
      "https://a.example/a?q=cats",
    )
    expect(maskUrl("data:text/plain,secret")).toBe("data:…")
  })
})

describe.skipIf(!executable)(
  "the browser's mouse, scripts and logs",
  { timeout: 90_000 },
  () => {
    it("clicks, scrolls and drags at a point of the viewport", async () => {
      const tab = await open("/canvas")

      const clicked = await call("click", { tab, x: 120, y: 80 })
      expect(clicked.isError, textOf(clicked)).toBeUndefined()
      expect(textOf(clicked)).toContain("Clicked at x 120, y 80")
      expect(await title(tab)).toContain("click 120,80")

      await call("click", { tab, x: 30, y: 40, button: "right" })
      expect(await title(tab)).toContain("menu 30,40 b2")

      await call("click", { tab, x: 50, y: 60, double: true })
      expect(await title(tab)).toContain("dbl 50,60")

      await call("scroll", { tab, direction: "down", x: 200, y: 210 })
      expect(await title(tab)).toContain("wheel1 200,210")

      const dragged = await call("drag", {
        tab,
        x: 10,
        y: 20,
        to_x: 310,
        to_y: 220,
      })
      expect(textOf(dragged)).toContain(
        "Dragged from x 10, y 20 to x 310, y 220",
      )
      expect(await title(tab)).toMatch(/down 10,20 \| up 310,220/)

      const picture = await call("screenshot", { tab })
      expect(textOf(picture)).toMatch(/viewport's CSS pixels/)
      const smaller = await call("screenshot", { tab, max_width: 640 })
      expect(textOf(smaller)).toMatch(/is x x × 2, y y × 2/)
    })

    it("asks the owner per site, with the whole script, before it runs one", async () => {
      const tab = await open("/app")
      const script = "document.title"

      const asked = await owner(call("evaluate", { tab, script }))
      const site = new URL(api.origin).host
      expect(asked.ask).toEqual({
        kind: "script_use",
        input: {
          serverId: server.id,
          tabId: tab,
          site: new URL(api.origin).host,
          url: `${api.origin}/app`,
          title: "App",
          script,
        },
      })

      // Run it once: this script, once.
      allowScriptOnce({
        tokenId,
        tabId: tab,
        site: site,
        script,
      })
      const once = await call("evaluate", { tab, script })
      expect(textOf(once)).toContain('"App"')
      await owner(call("evaluate", { tab, script }))

      await writeScriptAccess(ctx.vaultId, tokenId, site, "blocked")
      const blocked = await call("evaluate", { tab, script })
      expect(blocked.isError).toBe(true)
      expect(textOf(blocked)).toContain("blocked scripts")

      await writeScriptAccess(ctx.vaultId, tokenId, site, "allowed")
      expect(await decideScript(ctx.vaultId, tokenId, site)).toBe("allowed")

      const state = await call("evaluate", { tab, script: "window.appState" })
      expect(JSON.parse(textOf(state).split("Result (JSON):\n")[1]!)).toEqual({
        user: "ada",
        items: [1, 2, 3],
      })
      const statements = await call("evaluate", {
        tab,
        script: "const n = await Promise.resolve(20); n + 1",
      })
      expect(textOf(statements)).toMatch(/Result \(JSON\):\n21$/)
      const fn = await call("evaluate", {
        tab,
        script: "async () => location.pathname",
      })
      expect(textOf(fn)).toMatch(/"\/app"$/)
      const threw = await call("evaluate", {
        tab,
        script: "throw new Error('nope')",
      })
      expect(threw.isError).toBe(true)
      expect(textOf(threw)).toContain("nope")
      const slow = await call("evaluate", {
        tab,
        script: "new Promise(() => {})",
      })
      expect(textOf(slow)).toContain("did not finish")
      const forever = await call("evaluate", { tab, script: "while (true) {}" })
      expect(textOf(forever)).toContain("did not finish")

      const long = await call("evaluate", {
        tab,
        script: "'x'.repeat(5000)",
      })
      expect(textOf(long)).toContain('"$result"')
      expect(kept.at(-1)?.text).toHaveLength(5002)
    })

    it("keeps the tab at its site while a script runs", async () => {
      const tab = await open("/app")
      await writeScriptAccess(
        ctx.vaultId,
        tokenId,
        new URL(api.origin).host,
        "allowed",
      )
      const before = elsewhere.requests.length

      const ran = await call("evaluate", {
        tab,
        script: `(async () => {
  const out = {}
  const tryFetch = (url) => fetch(url).then(() => "ok", () => "refused")
  out.same = await tryFetch("/page")
  out.other = await tryFetch("${elsewhere.origin}/leak?x=1")
  out.beacon = navigator.sendBeacon("${elsewhere.origin}/beacon", "x")
  const ws = new WebSocket("ws://${sockets.origin}/ws")
  out.socket = await new Promise((r) => { ws.onopen = () => r("open"); ws.onerror = () => r("refused") })
  out.popup = window.open("${elsewhere.origin}/popup") ? "opened" : "none"
  return out
})()`,
      })
      expect(ran.isError, textOf(ran)).toBeUndefined()
      const result = JSON.parse(textOf(ran).split("Result (JSON):\n")[1]!)
      expect(result).toMatchObject({
        same: "ok",
        other: "refused",
        socket: "refused",
      })
      expect(textOf(ran)).toContain("It reached for other sites")
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(elsewhere.requests.length).toBe(before)
      expect(sockets.upgrades).toEqual([])
      // Its popup is gone, and the tab is the only one.
      expect([...runningBrowser(ctx.vaultId)!.tabs.keys()]).toEqual([tab])

      // Afterwards the page reaches elsewhere as before: a request the
      // script left for later goes once it is done.
      await call("evaluate", {
        tab,
        script: `setTimeout(() => fetch("${elsewhere.origin}/after", { mode: "no-cors" }), 100); 1`,
      })
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(elsewhere.requests.map((request) => request.url)).toContain(
        "/after",
      )
    })

    it("refuses a script while a field holds a typed secret", async () => {
      const tab = await open("/app")
      await writeScriptAccess(
        ctx.vaultId,
        tokenId,
        new URL(api.origin).host,
        "allowed",
      )
      const page = runningBrowser(ctx.vaultId)!.tabs.get(tab)!.page
      await page.locator("#field").fill("hunter2-hunter2")
      holdSecret(page, "Shop", "hunter2-hunter2")

      const refused = await call("evaluate", {
        tab,
        script: "document.getElementById('field').value",
      })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain('holds the secret "Shop"')

      // Once the field lets go, a value the page repeats is still masked.
      await page.locator("#field").fill("")
      const masked = await call("evaluate", {
        tab,
        script: "'pw: hunter2-hunter2'",
      })
      expect(textOf(masked)).toContain("pw: [secret: Shop]")
      expect(textOf(masked)).not.toContain("hunter2")
    })

    it("lists the tab's requests without credentials, and keeps a body when asked", async () => {
      const tab = await open("/app")
      await new Promise((resolve) => setTimeout(resolve, 500))

      const listed = JSON.parse(
        textOf(await call("network_log", { tab, url: "/api/" })),
      ) as {
        entries: Array<{
          id: string
          method: string
          url: string
          status: number
          requestHeaders: Record<string, string>
          responseHeaders: Record<string, string>
        }>
      }
      expect(listed.entries).toHaveLength(1)
      const entry = listed.entries[0]!
      expect(entry).toMatchObject({
        method: "POST",
        url: `${api.origin}/api/items?token=%5Bmasked%5D&page=2`,
        status: 200,
      })
      const headers = JSON.stringify(entry.requestHeaders).toLowerCase()
      expect(headers).not.toMatch(/authorization|csrf|t0ken/)
      expect(entry.requestHeaders["content-type"]).toBe("application/json")
      const answered = JSON.stringify(entry.responseHeaders).toLowerCase()
      expect(answered).not.toMatch(/set-cookie|s3cr3t|api-key|k3y/)

      const bodies = JSON.parse(
        textOf(await call("network_log", { tab, body: entry.id })),
      ) as { request_body: { $result: string }; response_body: unknown }
      expect(bodies.request_body.$result).toBeTruthy()
      expect(bodies.response_body).toBeTruthy()
      expect(kept.map((one) => one.text)).toEqual([
        '{"q":"plain"}',
        '{"ok":true,"echo":"{\\"q\\":\\"plain\\"}"}',
      ])
    })

    it("reads the browser's console messages, and the page's from the first call on", async () => {
      const tab = await open("/app")
      await new Promise((resolve) => setTimeout(resolve, 300))

      const first = JSON.parse(textOf(await call("console_log", { tab }))) as {
        entries: Array<{ level: string; source: string; text: string }>
        note?: string
      }
      expect(first.note).toContain("listened to from now on")
      expect(first.entries).toContainEqual(
        expect.objectContaining({ source: "network", level: "error" }),
      )

      await writeScriptAccess(
        ctx.vaultId,
        tokenId,
        new URL(api.origin).host,
        "allowed",
      )
      await call("evaluate", {
        tab,
        script:
          "console.warn('careful', 42); setTimeout(() => { throw new Error('boom') })",
      })
      await new Promise((resolve) => setTimeout(resolve, 200))

      const later = JSON.parse(
        textOf(await call("console_log", { tab, level: "warning" })),
      ) as { entries: Array<{ text: string }> }
      expect(later.entries.map((entry) => entry.text)).toEqual(["careful 42"])
      const errors = JSON.parse(
        textOf(await call("console_log", { tab, text: "boom" })),
      ) as { entries: Array<{ source: string }> }
      expect(errors.entries).toEqual([
        expect.objectContaining({ source: "exception" }),
      ])
    })
  },
)
