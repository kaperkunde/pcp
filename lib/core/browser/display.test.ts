import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import net from "node:net"

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { VaultContext } from "../context"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  acquireDisplay,
  runningDisplay,
  setXvfbCommand,
  wantsVirtualDisplay,
} from "./display"
import { chromiumExecutable } from "./executable"
import { closeAllBrowsers, ensureBrowser, openTab } from "./runtime"

// The virtual display a server's browser runs on, against the machine's own
// Xvfb. Skipped where there is none (`apt install xvfb`).

const xvfb = (() => {
  try {
    execFileSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()
const executable = await chromiumExecutable()

afterEach(() => {
  vi.unstubAllEnvs()
  setXvfbCommand(null)
})

afterAll(async () => {
  await closeAllBrowsers()
})

describe("whether the browser uses a virtual display", () => {
  it("does in the container image, or when asked, and never in the desktop app", () => {
    vi.stubEnv("PCP_DESKTOP", "")
    vi.stubEnv("PCP_BROWSER_DISPLAY", "")
    vi.stubEnv("PCP_CONTAINER", "1")
    expect(wantsVirtualDisplay()).toBe(process.platform === "linux")

    vi.stubEnv("PCP_CONTAINER", "")
    expect(wantsVirtualDisplay()).toBe(false)

    vi.stubEnv("PCP_BROWSER_DISPLAY", "virtual")
    expect(wantsVirtualDisplay()).toBe(process.platform === "linux")

    vi.stubEnv("PCP_CONTAINER", "1")
    vi.stubEnv("PCP_BROWSER_DISPLAY", "headless")
    expect(wantsVirtualDisplay()).toBe(false)

    vi.stubEnv("PCP_BROWSER_DISPLAY", "virtual")
    vi.stubEnv("PCP_DESKTOP", "1")
    expect(wantsVirtualDisplay()).toBe(false)
  })
})

/** The cookie in an Xauthority file's first entry. */
function cookieOf(file: string): Buffer {
  const bytes = readFileSync(file)
  let at = 2

  const field = () => {
    const length = bytes.readUInt16BE(at)
    const value = bytes.subarray(at + 2, at + 2 + length)
    at += 2 + length
    return value
  }

  field()
  field()
  expect(field().toString()).toBe("MIT-MAGIC-COOKIE-1")
  return field()
}

/** Opens an X connection and answers whether the server let it in. */
function xConnects(display: string, cookie: Buffer | null): Promise<boolean> {
  const pad = (length: number) => Buffer.alloc((4 - (length % 4)) % 4)
  const name = cookie ? Buffer.from("MIT-MAGIC-COOKIE-1") : Buffer.alloc(0)
  const data = cookie ?? Buffer.alloc(0)
  const head = Buffer.alloc(12)
  head.write("l", 0)
  head.writeUInt16LE(11, 2)
  head.writeUInt16LE(0, 4)
  head.writeUInt16LE(name.length, 6)
  head.writeUInt16LE(data.length, 8)

  return new Promise((resolve, reject) => {
    const socket = net.connect(`/tmp/.X11-unix/X${display.slice(1)}`)
    socket.once("error", reject)
    socket.once("data", (chunk) => {
      socket.destroy()
      resolve(chunk[0] === 1)
    })
    socket.write(
      Buffer.concat([head, name, pad(name.length), data, pad(data.length)]),
    )
  })
}

/** Whether the display stopped and its cookie folder went, soon. */
async function stopped(authFile?: string): Promise<boolean> {
  const gone = () =>
    runningDisplay() === null && !(authFile && existsSync(authFile))

  for (let i = 0; i < 50 && !gone(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return gone()
}

describe.skipIf(!xvfb)("the virtual display", { timeout: 60_000 }, () => {
  it("starts once for every browser, and stops when the last gives it back", async () => {
    const first = await acquireDisplay()
    const second = await acquireDisplay()

    expect(first?.display.display).toMatch(/^:\d+$/)
    expect(second?.display).toEqual(first?.display)
    expect(
      existsSync(`/tmp/.X11-unix/X${first!.display.display.slice(1)}`),
    ).toBe(true)

    first!.release()
    first!.release()
    expect(runningDisplay()).toEqual(first!.display)

    second!.release()
    expect(await stopped(first!.display.authFile)).toBe(true)
  })

  it("lets in only a client with its cookie", async () => {
    const held = await acquireDisplay()
    const { display, authFile } = held!.display

    expect(await xConnects(display, null)).toBe(false)
    expect(await xConnects(display, Buffer.alloc(16))).toBe(false)
    expect(await xConnects(display, cookieOf(authFile))).toBe(true)

    held!.release()
    expect(await stopped()).toBe(true)
  })

  it("leaves the browser headless when Xvfb does not start", async () => {
    setXvfbCommand("/nonexistent/Xvfb")

    expect(await acquireDisplay()).toBeNull()
    expect(runningDisplay()).toBeNull()
  })
})

describe.skipIf(!xvfb || !executable)(
  "a browser on the virtual display",
  { timeout: 90_000 },
  () => {
    let cleanup: () => Promise<void>
    let ctx: VaultContext
    let api: TestApi

    beforeEach(async () => {
      ;({ cleanup } = await scratchDatabase())
      ctx = await setupVault({
        name: "Ada",
        password: "correct horse battery staple",
      })
      api = await startTestApi((_, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.end(`<!doctype html><title>?</title><script>
const gl = document.createElement("canvas").getContext("webgl")
document.title = JSON.stringify({
  window: [outerWidth, outerHeight, innerWidth, innerHeight],
  screen: [screen.width, screen.height],
  webgl: gl ? gl.getParameter(gl.RENDERER) : null,
})
</script>`)
      })
    })

    afterEach(async () => {
      await closeAllBrowsers()
      await api.close()
      await cleanup()
    })

    it("has a window around the page, a screen, and WebGL", async () => {
      vi.stubEnv("PCP_BROWSER_DISPLAY", "virtual")
      vi.stubEnv("PCP_DESKTOP", "")

      const vault = await ensureBrowser(ctx)
      expect(vault.display).toBe(runningDisplay()?.display)

      const tab = await openTab(vault, {
        openedBy: "owner",
        tokenId: null,
        rules: null,
        privateAllowed: true,
      })
      await tab.page.goto(api.origin)
      const seen = JSON.parse(await tab.page.title()) as {
        window: number[]
        screen: number[]
        webgl: string | null
      }

      expect(seen.window[2]).toBe(1280)
      expect(seen.window[3]).toBe(800)
      expect(seen.window[1]).toBeGreaterThan(seen.window[3]!)
      expect(seen.screen).toEqual([1920, 1080])
      expect(seen.webgl).toBeTruthy()

      await closeAllBrowsers()
      expect(await stopped()).toBe(true)
    })

    it("is headless where no display is wanted", async () => {
      vi.stubEnv("PCP_BROWSER_DISPLAY", "headless")

      const vault = await ensureBrowser(ctx)

      expect(vault.display).toBeNull()
      expect(runningDisplay()).toBeNull()
    })
  },
)
