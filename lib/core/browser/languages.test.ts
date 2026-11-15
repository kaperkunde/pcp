import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startTestApi, type TestApi } from "../openapi/test-api"
import { acquireDisplay } from "./display"
import { chromiumExecutable } from "./executable"
import { contextOptions, launchOptions, type BrowserMode } from "./launch"

// What a page and a site read of the browser's languages, against a real
// Chromium started as PCP starts it: a person's Chrome sends
// "en-US,en;q=0.9" and lists ["en-US", "en"], never the bare locale.

const executable = await chromiumExecutable()

let api: TestApi

beforeAll(async () => {
  api = await startTestApi((_, res) => {
    res.setHeader("content-type", "text/html")
    res.end("<title>languages</title>")
  })
})

afterAll(async () => {
  await api?.close()
})

async function languagesIn(mode: BrowserMode, languages: string[]) {
  const { chromium } = await import("patchright-core")
  const screen = mode === "virtual" ? await acquireDisplay() : null
  if (mode === "virtual" && !screen) return null

  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "pcp-languages-"))
  const browser = await chromium.launch({
    ...launchOptions({
      mode,
      executablePath: executable!,
      sandbox: false,
      scratchDir,
      display: screen?.display ?? null,
      languages,
    }),
    timeout: 30_000,
  })

  try {
    const context = await browser.newContext(
      contextOptions(browser.version(), mode),
    )
    const page = await context.newPage()
    const before = api.requests.length
    await page.goto(`${api.origin}/`)
    const header = api.requests
      .slice(before)
      .find((request) => request.url === "/")?.headers["accept-language"]

    return {
      header,
      languages: await page.evaluate(() => [...navigator.languages]),
    }
  } finally {
    await browser.close()
    screen?.release()
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

describe.skipIf(!executable)(
  "the browser's languages, in Chromium",
  { timeout: 120_000 },
  () => {
    for (const mode of ["headless", "virtual"] as const) {
      it(`are a person's Chrome's (${mode})`, async () => {
        const seen = await languagesIn(mode, ["en-US", "en"])
        if (!seen) return // no Xvfb on this machine

        expect(seen.header).toBe("en-US,en;q=0.9")
        expect(seen.languages).toEqual(["en-US", "en"])
      })
    }

    it("follow the host's locale", async () => {
      const seen = await languagesIn("headless", ["nl-NL", "nl"])

      expect(seen!.header).toMatch(/^nl-NL,nl;q=0\.9/)
      expect(seen!.languages.slice(0, 2)).toEqual(["nl-NL", "nl"])
    })
  },
)
