import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { CHALLENGE_LINE } from "../fetch/challenge"
import { prepareFetch, type FetchArgs } from "../fetch/request"
import { siteKey } from "../fetch/rules"
import {
  answerWalled,
  startTestApi,
  WALL_COOKIE,
  type TestApi,
} from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { chromiumExecutable } from "./executable"
import { loadProfile } from "./profile"
import {
  closeAllBrowsers,
  ensureBrowser,
  openTab,
  runningBrowser,
  saveVaultProfile,
} from "./runtime"
import { createBrowserServer } from "./server"
import {
  fetchThroughBrowser,
  GET_ONLY_LINE,
  hasClearance,
  NOT_PASSED_LINE,
  solverAvailable,
  SOURCE_AFTER_CHECK,
  SOURCE_PLAIN,
} from "./solve"

// web_fetch's read through the browser, against a real headless Chromium
// and a fake Cloudflare check served on this machine. Skipped where no
// Chromium is installed.

const executable = await chromiumExecutable()

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let elsewhere: TestApi

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  elsewhere = await startTestApi((_, res) => res.end("elsewhere"))
  api = await startTestApi((request, res) => {
    if (request.url.startsWith("/walled-forever")) {
      return answerWalled(request, res, { clears: false })
    }

    if (request.url.startsWith("/walled")) {
      return answerWalled(request, res)
    }

    if (request.url.startsWith("/away")) {
      res.statusCode = 302
      res.setHeader("location", `${elsewhere.origin}/landed`)
      return res.end()
    }

    if (request.url.startsWith("/sign-in")) {
      res.setHeader("set-cookie", "session=owner; path=/")
      return res.end("<title>Signed in</title>")
    }

    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(
      `<title>Cookie</title><h1>cookie: ${request.headers.cookie ?? "none"}</h1>`,
    )
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

function get(path: string, extra: Partial<FetchArgs> = {}): FetchArgs {
  return { ...prepareFetch({ url: `${api.origin}${path}` }), ...extra }
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

function site(): string {
  return siteKey(new URL(api.origin))
}

describe.skipIf(!executable)(
  "web_fetch through the browser",
  { timeout: 90_000 },
  () => {
    it("reads a page behind a check, and remembers that the site passed it", async () => {
      expect(hasClearance(ctx.vaultId, site())).toBe(false)

      const answer = await fetchThroughBrowser(ctx, get("/walled"), {
        allowPrivate: true,
      })
      const text = textOf(answer.result)

      expect(answer.challenged).toBe(false)
      expect(answer.result.isError).toBeUndefined()
      expect(text).toContain(`URL: ${api.origin}/walled`)
      expect(text).toContain("Status: HTTP 200 OK")
      expect(text).toContain("Title: Walled")
      expect(text).toContain(
        `Type: text/html, as Markdown (${SOURCE_AFTER_CHECK})`,
      )
      expect(text).toContain("Behind the wall")
      expect(text).not.toContain(CHALLENGE_LINE)

      expect(hasClearance(ctx.vaultId, site())).toBe(true)
      const vault = runningBrowser(ctx.vaultId)!
      // The page is closed, and was never a tab.
      expect(vault.solves.size).toBe(0)
      expect(vault.solving).toBe(0)
      expect(vault.tabs.size).toBe(0)
    })

    it("hands back a part of the text as web_fetch does", async () => {
      const answer = await fetchThroughBrowser(
        ctx,
        get("/walled", { maxLength: 8, raw: true }),
        { allowPrivate: true },
      )
      const text = textOf(answer.result)

      expect(text).toContain("Type: text/html (")
      expect(text).toMatch(
        /Characters 0 to 8 of \d+; call again with start_index 8/,
      )
      expect(text.split("\n\n")[1]).toHaveLength(8)
    })

    it("shares nothing with the vault's sign-ins", async () => {
      const vault = await ensureBrowser(ctx)
      const tab = await openTab(vault, {
        openedBy: "owner",
        tokenId: null,
        rules: null,
        privateAllowed: true,
      })
      await tab.page.goto(`${api.origin}/sign-in`)
      expect(
        (await vault.context.cookies()).map((cookie) => cookie.name),
      ).toContain("session")

      // The sign-in does not go with the read, and a page with no check is
      // read as it is.
      const plain = await fetchThroughBrowser(ctx, get("/cookie"), {
        allowPrivate: true,
      })
      expect(plain.challenged).toBe(false)
      expect(textOf(plain.result)).toContain("cookie: none")
      expect(textOf(plain.result)).toContain(`(${SOURCE_PLAIN})`)

      // What passing the check gave the browser does not become a sign-in.
      await fetchThroughBrowser(ctx, get("/walled"), { allowPrivate: true })
      await saveVaultProfile(ctx, vault, { force: true })
      const saved = (await loadProfile(ctx))?.cookies.map((c) => c.name) ?? []
      expect(saved).toContain("session")
      expect(saved).not.toContain(WALL_COOKIE)
      expect(
        (await vault.context.cookies()).map((cookie) => cookie.name),
      ).not.toContain(WALL_COOKIE)
    })

    it("says when the check does not pass, and leaves what to do to the caller", async () => {
      const answer = await fetchThroughBrowser(ctx, get("/walled-forever"), {
        allowPrivate: true,
      })
      const text = textOf(answer.result)

      expect(answer.challenged).toBe(true)
      expect(answer.result.isError).toBe(true)
      expect(text).toContain(`URL: ${api.origin}/walled-forever`)
      expect(text).toContain("Status: HTTP 403 Forbidden")
      expect(text).toContain(CHALLENGE_LINE)
      expect(text).toContain(NOT_PASSED_LINE)
      expect(text).not.toContain("hand_over")
      expect(hasClearance(ctx.vaultId, site())).toBe(false)
      expect(runningBrowser(ctx.vaultId)!.solves.size).toBe(0)
    })

    it("stops at a redirect to another site, which gets its own decision", async () => {
      const answer = await fetchThroughBrowser(ctx, get("/away"), {
        allowPrivate: true,
      })
      const text = textOf(answer.result)

      expect(answer.challenged).toBe(false)
      expect(answer.result.isError).toBeUndefined()
      expect(text).toContain("HTTP 302 Found")
      expect(text).toContain(
        `${api.origin}/away redirects to ${elsewhere.origin}/landed, which is another site.`,
      )
      expect(text).toContain(`call web_fetch with ${elsewhere.origin}/landed`)
      expect(elsewhere.requests).toHaveLength(0)
    })

    it("reaches a private address only where the owner allowed it for the token", async () => {
      const answer = await fetchThroughBrowser(ctx, get("/cookie"), {
        allowPrivate: false,
      })
      const text = textOf(answer.result)

      expect(answer.challenged).toBe(false)
      expect(answer.result.isError).toBe(true)
      expect(text).toContain(
        `${site()} is, or resolves to, a private or local address`,
      )
      expect(api.requests).toHaveLength(0)
      expect(hasClearance(ctx.vaultId, site())).toBe(false)
    })

    it("reads a GET again and nothing else, without opening a page", async () => {
      const answer = await fetchThroughBrowser(
        ctx,
        get("/walled", { method: "POST", body: "a=1" }),
        { allowPrivate: true },
      )
      const text = textOf(answer.result)

      expect(answer.challenged).toBe(true)
      expect(answer.result.isError).toBe(true)
      expect(text).toContain(CHALLENGE_LINE)
      expect(text).toContain(GET_ONLY_LINE)
      expect(text).not.toContain(api.origin)
      expect(api.requests).toHaveLength(0)
      expect(runningBrowser(ctx.vaultId)).toBeNull()
    })

    it("never opens PCP's own site", async () => {
      const answer = await fetchThroughBrowser(ctx, get("/walled"), {
        allowPrivate: true,
        publicUrl: api.origin,
      })

      expect(answer.challenged).toBe(false)
      expect(answer.result.isError).toBe(true)
      expect(textOf(answer.result)).toContain("is PCP's own address")
      expect(api.requests).toHaveLength(0)
      expect(runningBrowser(ctx.vaultId)).toBeNull()
    })

    it("is available once the owner added the browser, while it is enabled", async () => {
      expect(await solverAvailable(ctx)).toBe(false)

      const { id } = await createBrowserServer(ctx)
      expect(await solverAvailable(ctx)).toBe(true)

      await db().mcpServer.update({ where: { id }, data: { enabled: false } })
      expect(await solverAvailable(ctx)).toBe(false)
    })
  },
)
