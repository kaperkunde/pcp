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
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { resetPacing, setPacingClock } from "../pacing/pace"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { callBrowserTool } from "./call"
import { chromiumExecutable } from "./executable"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"

// Calls on a tab wait in that tab's lane, against a real headless Chromium
// (skipped where there is none, as call.test.ts is): one tab's slow call
// does not hold up another tab, a call past its deadline gets its tab
// reopened, a caller that gives up stops waiting, and a crashed page is
// reopened on the next call. The deadline is three seconds here, not the
// hundred a page load and a check may take.

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./limits")>()),
  TAB_DEADLINE_MS: 3_000,
}))

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"

let cleanup: () => Promise<void>
let api: TestApi
let ctx: VaultContext
let tokenId: string
let server: McpServer

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
  api = await startTestApi((request, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(`<title>Page ${request.url}</title><h1>Page ${request.url}</h1>`)
  })
  await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
  await setFetchPrivate(ctx, tokenId, "allowed")
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await cleanup()
})

afterAll(async () => {
  await closeAllBrowsers()
})

function call(
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return callBrowserTool(ctx, server, name, args, {
    tokenId,
    publicUrl: PUBLIC_URL,
    signal,
  })
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

async function openTab(path: string): Promise<string> {
  const opened = await call("tabs", { action: "open", url: api.origin + path })
  return textOf(opened).match(/^Tab (\S+):/m)![1]!
}

describe.skipIf(!executable)("a tab's lane", { timeout: 60_000 }, () => {
  it("holds up only its own tab: a slow call on one does not delay another", async () => {
    const slow = await openTab("/a")
    const quick = await openTab("/b")

    const waiting = call("wait_for", { tab: slow, ms: 2_500 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const started = Date.now()
    const other = await call("snapshot", { tab: quick })
    expect(textOf(other)).toContain("Page /b")
    expect(Date.now() - started).toBeLessThan(1_500)

    // Opening a tab does not wait for it either.
    const opening = Date.now()
    await openTab("/c")
    expect(Date.now() - opening).toBeLessThan(2_000)

    expect((await waiting).isError).toBeUndefined()
  })

  it("reopens a tab whose call passes its deadline, says so, and goes on with the next call", async () => {
    const tab = await openTab("/stuck")
    const vault = runningBrowser(ctx.vaultId)!
    const before = vault.tabs.get(tab)!.page

    const started = Date.now()
    const stuck = call("wait_for", { tab, ms: 20_000 })
    const next = call("snapshot", { tab })

    const answered = await stuck
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(answered.isError).toBe(true)
    expect(textOf(answered)).toBe(
      `This tab (${tab}) stopped responding and was reopened at ${api.origin}/stuck. What the call was doing may or may not have happened: take a snapshot to see the page.`,
    )

    // The same tab, a new page, at the same address.
    const after = vault.tabs.get(tab)!
    expect(after.page).not.toBe(before)
    expect(before.isClosed()).toBe(true)
    expect(after.unresponsive).toBe(false)
    const snapshot = textOf(await next)
    expect(snapshot).toContain(`Tab ${tab}:`)
    expect(snapshot).toContain("Page /stuck")
  })

  it("stops waiting for a caller that gives up, and passes its turn on", async () => {
    const tab = await openTab("/a")
    const gaveUp = new AbortController()

    const waiting = call("wait_for", { tab, ms: 20_000 }, gaveUp.signal)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const started = Date.now()
    gaveUp.abort(new Error("The run stopped."))

    await expect(waiting).rejects.toThrow("The run stopped.")
    const next = await call("snapshot", { tab })
    expect(textOf(next)).toContain("Page /a")
    expect(Date.now() - started).toBeLessThan(1_500)

    // A caller that had given up already is not queued at all.
    await expect(call("snapshot", { tab }, gaveUp.signal)).rejects.toThrow(
      "The run stopped.",
    )
  })

  it("closes a tab without waiting behind a call that hangs on it", async () => {
    const tab = await openTab("/a")
    const stuck = call("wait_for", { tab, ms: 20_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))

    const started = Date.now()
    expect(textOf(await call("tabs", { action: "close", tab }))).toBe(
      `Closed tab ${tab}.`,
    )
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(runningBrowser(ctx.vaultId)!.tabs.has(tab)).toBe(false)

    // The hung call ends with its tab.
    expect(textOf(await stuck)).toContain(`There is no tab ${tab}`)
  })

  it("resets a tab on request, at its address", async () => {
    const tab = await openTab("/reset")
    const before = runningBrowser(ctx.vaultId)!.tabs.get(tab)!.page

    const reset = await call("tabs", { action: "reset", tab })
    expect(reset.isError).toBeUndefined()
    expect(textOf(reset)).toContain(
      `Tab ${tab} was reset: its page was closed and was reopened at ${api.origin}/reset.`,
    )
    expect(before.isClosed()).toBe(true)
    expect(textOf(await call("snapshot", { tab }))).toContain("Page /reset")
  })

  it("reopens a crashed page on the next call", async () => {
    const tab = await openTab("/crash")
    const current = runningBrowser(ctx.vaultId)!.tabs.get(tab)!
    // The renderer dies before it can answer.
    void current.cdp.send("Page.crash").catch(() => {})
    await vi.waitFor(() => expect(current.unresponsive).toBe(true), {
      timeout: 5_000,
    })

    const next = await call("snapshot", { tab })
    expect(next.isError).toBe(true)
    expect(textOf(next)).toBe(
      `This tab (${tab}) stopped responding: its page crashed, and it was reopened at ${api.origin}/crash. Nothing else was done; take a snapshot, then call again.`,
    )
    expect(textOf(await call("snapshot", { tab }))).toContain("Page /crash")
  })
})

describe.skipIf(!executable)("a tab a program has", { timeout: 60_000 }, () => {
  function asRun(name: string, args: Record<string, unknown>, runId: string) {
    return callBrowserTool(ctx, server, name, args, {
      tokenId,
      publicUrl: PUBLIC_URL,
      runId,
    })
  }

  const NOTICE =
    "A running program (run run_a) is acting on this tab right now; what you see may change under it."

  it("is said in one line in front of another call's answer, which still runs", async () => {
    const tab = await openTab("/a")

    const running = asRun("wait_for", { tab, ms: 1_500 }, "run_a")
    await new Promise((resolve) => setTimeout(resolve, 200))
    const read = await call("snapshot", { tab })

    expect(read.isError).toBeUndefined()
    expect(textOf(read).split("\n")[0]).toBe(NOTICE)
    expect(textOf(read)).toContain("Page /a")
    expect(textOf(await running)).not.toContain("A running program")

    // Another run's call is told; the run's own, and a call on a tab no
    // program has, are not.
    const again = asRun("wait_for", { tab, ms: 1_500 }, "run_a")
    await new Promise((resolve) => setTimeout(resolve, 200))
    const [other, own] = await Promise.all([
      asRun("snapshot", { tab }, "run_b"),
      asRun("snapshot", { tab }, "run_a"),
    ])
    expect(textOf(other).split("\n")[0]).toBe(NOTICE)
    expect(textOf(own)).not.toContain("A running program")
    await again
    expect(textOf(await call("snapshot", { tab }))).not.toContain(
      "A running program",
    )
  })
})

describe.skipIf(!executable)("pacing a tab", { timeout: 60_000 }, () => {
  let waits: number[]

  beforeEach(() => {
    vi.stubEnv("PCP_PACING", "")
    resetPacing()
    waits = []
    // Waits are noted, not waited: the browser's own clock runs as ever.
    setPacingClock({
      now: () => 1_000_000 + waits.reduce((sum, ms) => sum + ms, 0),
      sleep: async (ms) => {
        waits.push(ms)
      },
      random: () => 0,
    })
  })

  afterEach(() => {
    setPacingClock(null)
    resetPacing()
    vi.unstubAllEnvs()
  })

  it("paces acting by the site, before the call queues, and lets reading go", async () => {
    const tab = await openTab("/a")
    expect(waits).toEqual([])

    expect((await call("snapshot", { tab })).isError).toBeUndefined()
    expect(waits).toEqual([])

    const went = await call("navigate", { tab, url: `${api.origin}/b` })
    expect(textOf(went)).toContain("Page /b")
    expect(waits).toEqual([1_500])

    await call("press_key", { tab, key: "Tab" })
    expect(waits).toEqual([1_500, 1_500])
  })
})
