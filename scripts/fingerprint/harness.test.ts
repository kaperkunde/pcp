import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import { chromiumExecutable } from "../../lib/core/browser/executable"

const HARNESS = fileURLToPath(new URL("./harness.html", import.meta.url))
const page = readFileSync(HARNESS, "utf8")
const executable = await chromiumExecutable()

describe("the fingerprint harness", () => {
  it("loads nothing and sends nothing", () => {
    // No address of another site anywhere in it, and no way to reach one.
    expect(page).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i)
    expect(page).not.toMatch(/@import|[^a-z]url\(/i)
    expect(page).not.toMatch(
      /\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|new Image\(/,
    )
    // WebRTC without a STUN or TURN server: candidates of its own only.
    expect(page).toContain("iceServers: []")
  })

  it.skipIf(!executable)(
    "measures a browser and writes one JSON object",
    { timeout: 60_000 },
    async () => {
      const { chromium } = await import("patchright-core")
      const browser = await chromium.launch({
        executablePath: executable!,
        headless: true,
      })

      try {
        const tab = await browser.newPage()
        await tab.goto(`${pathToFileURL(HARNESS).href}?label=test`)
        await tab.waitForFunction(
          () => document.title === "Fingerprint: done",
          null,
          { timeout: 30_000 },
        )
        const result = JSON.parse((await tab.textContent("#json")) ?? "")

        expect(result.meta).toMatchObject({ harness: 1, label: "test" })
        for (const section of [
          "navigator",
          "userAgentData",
          "screen",
          "window",
          "webgl",
          "canvas",
          "audio",
          "fonts",
          "codecs",
          "intl",
          "permissions",
          "mediaDevices",
          "speech",
          "chrome",
          "automation",
          "apis",
          "storage",
          "webrtc",
          "behaviour",
        ]) {
          expect(result[section], section).toBeDefined()
          expect(result[section]?.error, section).toBeUndefined()
        }
        expect(Array.isArray(result.flags)).toBe(true)
      } finally {
        await browser.close()
      }
    },
  )
})
