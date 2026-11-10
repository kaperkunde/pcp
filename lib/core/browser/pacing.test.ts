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
import {
  readPacingConfig,
  setAssistantPaceBounds,
  setPacingClass,
  SETTING_PACING,
} from "../pacing/config"
import { resetPacing } from "../pacing/pace"
import {
  decidePermission,
  getPermissionView,
  withPermission,
} from "../permissions"
import { getSetting } from "../settings"
import { resultKeepers } from "../tool-results"
import { takeTurn } from "../pacing/pace"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { callBrowserTool } from "./call"
import { chromiumExecutable } from "./executable"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"
import { tabPace } from "./tab-pace"
import { isOwnerNeeded, type OwnerNeeded } from "./types"

// The browser's pacing against a real headless Chromium (lib/core/pacing/):
// each action takes its turn at the site on the tab's lane, after the one
// before it ended, so calls made at once never act closer than the pause,
// on one tab or across a site's tabs; and a tab's own pace, which an
// assistant sets within the owner's bounds, or the owner allows past them,
// in memory with the tab only. Skipped where no Chromium is installed.

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"
const PAUSE_MS = 400
/** How long the slow file takes to come in whole. */
const SLOW_FILE_MS = 3_000

/** Buttons that note when each click reached the page. */
const TAPS = `<!doctype html><title>Taps</title>
<button onclick="document.getElementById('taps').textContent += Date.now() + ' '">Tap</button>
<p id="taps" hidden></p>
<a href="/slow-file">File</a>`

let cleanup: () => Promise<void>
let api: TestApi
/** Another site, whose file comes slowly. */
let other: TestApi
let ctx: VaultContext
let tokenId: string
let server: McpServer

beforeEach(async () => {
  vi.stubEnv("PCP_PACING", "")
  resetPacing()
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
  const slowFile: Parameters<typeof startTestApi>[0] = (_, res) => {
    res.setHeader("content-type", "application/octet-stream")
    res.setHeader("content-disposition", 'attachment; filename="slow.bin"')
    res.write(Buffer.alloc(1024, 1))
    setTimeout(() => res.end(Buffer.alloc(1024, 2)), SLOW_FILE_MS)
  }
  api = await startTestApi((request, res) => {
    if (request.url.startsWith("/slow-file")) return slowFile(request, res)
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(TAPS)
  })
  other = await startTestApi(slowFile)
  await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
  await setFetchSite(ctx, tokenId, new URL(other.origin).host, "allowed")
  await setFetchPrivate(ctx, tokenId, "allowed")
  await setPacingClass(ctx, "browser_act", {
    minIntervalMs: PAUSE_MS,
    jitterMs: 0,
    burst: null,
  })
  await setPacingClass(ctx, "browser_navigate", "unpaced")
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await other.close()
  await cleanup()
  resetPacing()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await closeAllBrowsers()
})

function call(name: string, args: Record<string, unknown> = {}) {
  return callBrowserTool(ctx, server, name, args, {
    tokenId,
    publicUrl: PUBLIC_URL,
    keepBytes: resultKeepers(ctx, tokenId).bytes,
  })
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function tabOf(result: CallToolResult): string {
  const id = textOf(result).match(/^Tab (\S+):/m)?.[1]

  if (!id) {
    throw new Error(`no tab in:\n${textOf(result)}`)
  }

  return id
}

function refOf(result: CallToolResult): string {
  return textOf(result).match(/button "Tap" \[ref=(e\d+)\]/)![1]!
}

async function open(): Promise<{ tab: string; ref: string }> {
  const opened = await call("tabs", { action: "open", url: `${api.origin}/` })
  return { tab: tabOf(opened), ref: refOf(opened) }
}

/** When each click reached the tab's page, on this machine's clock. */
async function taps(tab: string): Promise<number[]> {
  const text = await runningBrowser(ctx.vaultId)!
    .tabs.get(tab)!
    .page.locator("#taps")
    .textContent()

  return (text ?? "").trim().split(/\s+/).filter(Boolean).map(Number)
}

function gaps(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b)
  return sorted.slice(1).map((time, index) => time - sorted[index]!)
}

async function owner(promise: Promise<unknown>): Promise<OwnerNeeded> {
  try {
    await promise
  } catch (error) {
    if (isOwnerNeeded(error)) return error
    throw error
  }

  throw new Error("the owner was not asked")
}

describe.skipIf(!executable)(
  "the browser's pacing",
  { timeout: 90_000 },
  () => {
    it("spaces clicks made at once on one tab by the pause, from the end of the one before", async () => {
      const { tab, ref } = await open()
      const answers = await Promise.all(
        Array.from({ length: 4 }, () => call("click", { tab, ref })),
      )

      for (const answer of answers) {
        expect(answer.isError, textOf(answer)).toBeFalsy()
      }

      const times = await taps(tab)
      expect(times).toHaveLength(4)

      for (const gap of gaps(times)) {
        expect(gap).toBeGreaterThanOrEqual(PAUSE_MS)
      }
    })

    it("spaces clicks that queued behind a long call from each other, not from when they asked", async () => {
      const { tab, ref } = await open()
      // The tab is busy for longer than the pause: both clicks wait on it.
      const busy = call("wait_for", { tab, ms: 1_500 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await Promise.all([
        busy,
        call("click", { tab, ref }),
        call("click", { tab, ref }),
      ])

      const times = await taps(tab)
      expect(times).toHaveLength(2)
      expect(gaps(times)[0]).toBeGreaterThanOrEqual(PAUSE_MS)
    })

    it("gives a download's turn back once its click is done, not while the file comes in", async () => {
      const first = await open()
      const second = await open()
      const opened = await call("snapshot", { tab: first.tab })
      const file = textOf(opened).match(/link "File" \[ref=(e\d+)\]/)![1]!

      const downloading = call("download", { tab: first.tab, ref: file })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await call("click", second)
      const tapped = (await taps(second.tab))[0]!
      const downloaded = await downloading
      const done = Date.now()

      expect(downloaded.isError, textOf(downloaded)).toBeFalsy()
      // The other tab of the site acted while the file was still coming.
      expect(done - tapped).toBeGreaterThan(1_000)
    })

    it("takes a download by its address in turn at that address's site, not the tab's", async () => {
      await setPacingClass(ctx, "browser_navigate", {
        minIntervalMs: 0,
        jitterMs: 0,
        burst: null,
      })
      const { tab } = await open()
      const host = new URL(other.origin).host
      const held = await takeTurn(`${ctx.vaultId}\nsite:${host}`, host, null)

      try {
        const waited = await call("download", {
          tab,
          url: `${other.origin}/slow-file`,
          timeout_ms: 2_000,
        })
        expect(waited.isError).toBe(true)
        // Its turn is the address's site's, which is busy: nothing went.
        expect(textOf(waited)).toContain(
          `Paced: another action at ${host} is still running`,
        )
      } finally {
        if ("release" in held) held.release()
      }
    })

    it("spaces a site's clicks across its tabs too", async () => {
      const first = await open()
      const second = await open()
      await Promise.all([
        call("click", first),
        call("click", second),
        call("click", first),
        call("click", second),
      ])

      const times = [...(await taps(first.tab)), ...(await taps(second.tab))]
      expect(times).toHaveLength(4)

      for (const gap of gaps(times)) {
        expect(gap).toBeGreaterThanOrEqual(PAUSE_MS)
      }
    })

    it("takes a tab's own pace within the owner's bounds, says it, and keeps it with the tab only", async () => {
      await setPacingClass(ctx, "browser_act", {
        minIntervalMs: 5_000,
        jitterMs: 0,
        burst: null,
      })
      const before = await getSetting(ctx, SETTING_PACING)
      const { tab, ref } = await open()

      const set = await call("tabs", {
        action: "pace",
        tab,
        pace: { actions: { min_ms: 100, max_ms: 150 } },
      })
      expect(set.isError, textOf(set)).toBeFalsy()
      expect(textOf(set)).toContain(
        "before actions in a page 0.1 to 0.15 s (its own)",
      )
      expect(textOf(set)).toContain("Assistants may set")

      const started = Date.now()
      await Promise.all([
        call("click", { tab, ref }),
        call("click", { tab, ref }),
        call("click", { tab, ref }),
      ])
      // Far quicker than the owner's five seconds, and still spaced.
      expect(Date.now() - started).toBeLessThan(5_000)

      const times = await taps(tab)
      expect(times).toHaveLength(3)

      for (const gap of gaps(times)) {
        expect(gap).toBeGreaterThanOrEqual(100)
      }

      expect(textOf(await call("tabs", { action: "list" }))).toContain(
        "its own pace: before actions in a page 0.1 to 0.15 s",
      )
      // Never stored: the vault's pacing settings are as they were.
      expect(await getSetting(ctx, SETTING_PACING)).toBe(before)

      // Without pace, the tab follows the owner's again.
      await call("tabs", { action: "pace", tab })
      expect(tabPace(runningBrowser(ctx.vaultId)!.tabs.get(tab)!)).toBeNull()
    })

    it("asks the owner for a pace outside their bounds, and sets it on that tab alone once they allow it", async () => {
      await setAssistantPaceBounds(ctx, {
        browser_act: { minMs: 200, maxMs: 2_000 },
      })
      const before = await getSetting(ctx, SETTING_PACING)
      const { tab } = await open()
      const other = await open()
      const pace = { actions: { min_ms: 20, max_ms: 60 } }

      const asked = await owner(call("tabs", { action: "pace", tab, pace }))
      expect(asked.ask).toMatchObject({
        kind: "tab_pace",
        input: {
          tabId: tab,
          pace: { actions: { minMs: 20, maxMs: 60 } },
          outside: ["browser_act"],
          bounds: { browser_act: { minMs: 200, maxMs: 2_000 } },
        },
      })
      // Nothing changed while it waits.
      const live = runningBrowser(ctx.vaultId)!.tabs.get(tab)!
      expect(tabPace(live)).toBeNull()

      const request = await withPermission(
        { ctx, tokenId, publicUrl: PUBLIC_URL },
        asked.ask as Parameters<typeof withPermission>[1],
      )
      const requestId = (await db().permissionRequest.findFirstOrThrow()).id
      expect(textOf(request)).toContain(requestId)

      const view = await getPermissionView(ctx, requestId, {
        publicUrl: PUBLIC_URL,
      })
      expect(view).toMatchObject({ kind: "tab_pace", tool: "tabs" })
      expect(view!.lines.join("\n")).toContain(
        "Before actions in a page: 0.02 to 0.06 s, outside what assistants may set without asking you (0.2 to 2 s)",
      )
      expect(view!.warning).toContain("Faster than you let assistants go")

      const allowed = await decidePermission(ctx, requestId, "allow_once", {
        publicUrl: PUBLIC_URL,
      })
      expect(textOf(allowed)).toContain(`tab ${tab} follows that pace now`)
      expect(tabPace(live)).toEqual({ actions: { minMs: 20, maxMs: 60 } })
      // That tab alone, and never the vault's settings.
      expect(
        tabPace(runningBrowser(ctx.vaultId)!.tabs.get(other.tab)!),
      ).toBeNull()
      expect(await getSetting(ctx, SETTING_PACING)).toBe(before)
      expect((await readPacingConfig(ctx)).assistant).toEqual({
        browser_act: { minMs: 200, maxMs: 2_000 },
      })
    })

    it("closes a pace request with its tab", async () => {
      await setAssistantPaceBounds(ctx, {
        browser_act: { minMs: 200, maxMs: 2_000 },
      })
      const { tab } = await open()
      const asked = await owner(
        call("tabs", {
          action: "pace",
          tab,
          pace: { actions: { min_ms: 20, max_ms: 60 } },
        }),
      )
      await withPermission(
        { ctx, tokenId, publicUrl: PUBLIC_URL },
        asked.ask as Parameters<typeof withPermission>[1],
      )

      await call("tabs", { action: "close", tab })

      await expect
        .poll(
          async () => (await db().permissionRequest.findFirstOrThrow()).status,
        )
        .toBe("closed")
    })

    it("refuses a pace whose shortest wait is past its longest", async () => {
      const { tab } = await open()
      const refused = await call("tabs", {
        action: "pace",
        tab,
        pace: { navigations: { min_ms: 900, max_ms: 100 } },
      })

      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain("the shortest wait comes first")
    })
  },
)
