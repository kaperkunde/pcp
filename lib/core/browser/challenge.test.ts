import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import {
  answerWalled,
  startTestApi,
  WALL_COOKIE,
  type TestApi,
} from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { chromiumExecutable } from "./executable"
import { MAX_SOLVES } from "./limits"
import {
  closeAllBrowsers,
  closeSolvePage,
  ensureBrowser,
  openSolvePage,
  openTab,
  type VaultBrowser,
} from "./runtime"

// Pages read for web_fetch (solve pages) and the watch on what a page's
// main frame shows, against a real headless Chromium and a fake Cloudflare
// check served on this machine. Skipped where no Chromium is installed.

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

async function solvePage(
  vault: VaultBrowser,
  path: string,
  privateAllowed = true,
) {
  const url = new URL(`${api.origin}${path}`)
  return openSolvePage(vault, { url, privateAllowed })
}

describe.skipIf(!executable)(
  "pages read for web_fetch",
  { timeout: 90_000 },
  () => {
    it("wait for a check that passes on its own, and then show the page", async () => {
      const vault = await ensureBrowser(ctx)
      const solve = await solvePage(vault, "/walled")

      await solve.page.goto(`${api.origin}/walled`, {
        waitUntil: "domcontentloaded",
      })
      expect(solve.documents.challenged()).toBe(true)
      expect(solve.documents.status()).toBe(403)

      expect(await solve.documents.pass(10_000)).toBe("passed")
      expect(solve.documents.challenged()).toBe(false)
      expect(solve.documents.status()).toBe(200)
      expect(await solve.page.title()).toBe("Walled")
      // Not a tab: nobody lists, watches or drives it.
      expect(vault.tabs.size).toBe(0)

      await closeSolvePage(vault, solve)
      expect(vault.solves.size).toBe(0)
    })

    it("say when a check does not pass", async () => {
      const vault = await ensureBrowser(ctx)
      const solve = await solvePage(vault, "/walled-forever")

      await solve.page.goto(`${api.origin}/walled-forever`, {
        waitUntil: "domcontentloaded",
      })

      expect(await solve.documents.pass(1_500)).toBe("still")
      expect(await solve.page.title()).toBe("Just a moment...")
      await closeSolvePage(vault, solve)
    })

    it("open their one site only: a redirect elsewhere is stopped and noted", async () => {
      const vault = await ensureBrowser(ctx)
      const solve = await solvePage(vault, "/away")

      await solve.page
        .goto(`${api.origin}/away`, { waitUntil: "domcontentloaded" })
        .catch(() => null)

      expect(solve.refused).toBe(`${elsewhere.origin}/landed`)
      expect(elsewhere.requests).toHaveLength(0)
      await closeSolvePage(vault, solve)
    })

    it("share no cookies with the vault's sign-ins", async () => {
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

      const solve = await solvePage(vault, "/walled")
      await solve.page.goto(`${api.origin}/walled`)
      expect(await solve.documents.pass(10_000)).toBe("passed")
      await solve.page.goto(`${api.origin}/cookie`)

      expect(await solve.page.textContent("h1")).toBe(
        `cookie: ${WALL_COOKIE}=passed`,
      )
      // The clearance stays in the fetch context, out of the sign-ins.
      expect(
        (await vault.context.cookies()).map((cookie) => cookie.name),
      ).not.toContain(WALL_COOKIE)
      await closeSolvePage(vault, solve)
    })

    it("reach a private address only as their own request's token may", async () => {
      const vault = await ensureBrowser(ctx)
      // A tab whose token may reach the owner's network does not open it for
      // a page read for another token's web_fetch.
      await openTab(vault, {
        openedBy: "owner",
        tokenId: null,
        rules: null,
        privateAllowed: true,
      })
      const since = Date.now()
      const refused = await solvePage(vault, "/cookie", false)

      await refused.page.goto(`${api.origin}/cookie`).catch(() => null)
      expect(api.requests).toHaveLength(0)
      expect(vault.proxy.refusal("127.0.0.1", since)).toBe("private")
      await closeSolvePage(vault, refused)

      const allowed = await solvePage(vault, "/cookie", true)
      await allowed.page.goto(`${api.origin}/cookie`)
      expect(await allowed.page.textContent("h1")).toBe("cookie: none")
      await closeSolvePage(vault, allowed)
    })

    it(`run at most ${MAX_SOLVES} at once`, async () => {
      const vault = await ensureBrowser(ctx)
      const open = await Promise.all(
        Array.from({ length: MAX_SOLVES }, () => solvePage(vault, "/cookie")),
      )

      await expect(solvePage(vault, "/cookie")).rejects.toMatchObject({
        code: "state",
      })

      await closeSolvePage(vault, open[0]!)
      const next = await solvePage(vault, "/cookie")
      await closeSolvePage(vault, next)
      for (const solve of open.slice(1)) await closeSolvePage(vault, solve)
      expect(vault.solving).toBe(0)
    })
  },
)

describe.skipIf(!executable)("a tab's documents", { timeout: 90_000 }, () => {
  it("are watched from its first page", async () => {
    const vault = await ensureBrowser(ctx)
    const tab = await openTab(vault, {
      openedBy: "owner",
      tokenId: null,
      rules: null,
      privateAllowed: true,
    })

    await tab.page.goto(`${api.origin}/walled`, {
      waitUntil: "domcontentloaded",
    })
    expect(tab.documents.challenged()).toBe(true)
    expect(await tab.documents.pass(10_000)).toBe("passed")
    expect(await tab.page.title()).toBe("Walled")
  })
})
