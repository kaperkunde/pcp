import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

import type { CDPSession } from "patchright-core"
import { describe, expect, it, vi } from "vitest"

import { displaySwitches } from "./display"
import {
  contextOptions,
  keepOffScreen,
  launchArgs,
  launchOptions,
  modesToTry,
  wantedMode,
} from "./launch"
import { OFF_SCREEN_WINDOW, SCREEN, SHOWN_WINDOW_POSITION } from "./limits"

describe("how the browser is wanted to run", () => {
  it("has a window of its own in the desktop app, wherever it runs", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(wantedMode({ PCP_DESKTOP: "1" }, platform), platform).toBe(
        "window",
      )
      // A virtual display is never the desktop app's: it starts no child
      // process, and has a screen.
      expect(
        wantedMode(
          { PCP_DESKTOP: "1", PCP_BROWSER_DISPLAY: "virtual" },
          platform,
        ),
        platform,
      ).toBe("window")
    }
  })

  it("has a window of its own on a Mac or Windows machine, and is headless on another", () => {
    expect(wantedMode({}, "darwin")).toBe("window")
    expect(wantedMode({}, "win32")).toBe("window")
    expect(wantedMode({}, "linux")).toBe("headless")
    expect(wantedMode({}, "freebsd")).toBe("headless")
  })

  it("is on the virtual display in the container image, or when asked on Linux", () => {
    expect(wantedMode({ PCP_CONTAINER: "1" }, "linux")).toBe("virtual")
    expect(wantedMode({ PCP_BROWSER_DISPLAY: "virtual" }, "linux")).toBe(
      "virtual",
    )
    expect(wantedMode({ PCP_BROWSER_DISPLAY: "virtual" }, "darwin")).toBe(
      "window",
    )
  })

  it("is headless wherever that is asked for", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(
        wantedMode(
          { PCP_BROWSER_DISPLAY: "headless", PCP_CONTAINER: "1" },
          platform,
        ),
      ).toBe("headless")
      expect(
        wantedMode(
          { PCP_BROWSER_DISPLAY: "headless", PCP_DESKTOP: "1" },
          platform,
        ),
      ).toBe("headless")
    }
  })

  it("falls back to headless when a window does not open, and only then", () => {
    expect(modesToTry("window")).toEqual(["window", "headless"])
    expect(modesToTry("virtual")).toEqual(["virtual"])
    expect(modesToTry("headless")).toEqual(["headless"])
  })
})

describe("what Chromium is started with", () => {
  const base = {
    executablePath: "/chromium",
    sandbox: true,
    scratchDir: "/scratch",
    display: { display: ":7", authFile: "/scratch/Xauthority" },
    env: { HOME: "/home/pcp" },
  }

  it("with a window of its own: not headless, off the screen, its own screen untouched", () => {
    const options = launchOptions({ ...base, mode: "window" })

    expect(options.headless).toBe(false)
    expect(options.args).toContain(
      `--window-position=${OFF_SCREEN_WINDOW.x},${OFF_SCREEN_WINDOW.y}`,
    )
    // Patchright-core sizes the window to the page; a size here would last
    // only until then.
    expect(options.args?.some((arg) => arg.startsWith("--window-size"))).toBe(
      false,
    )
    // The machine's own screen: not the virtual display's switches, and its
    // DISPLAY left as the session has it.
    for (const flag of displaySwitches()) {
      expect(options.args).not.toContain(flag)
    }
    expect(options.env).toEqual({
      HOME: "/home/pcp",
      XDG_CONFIG_HOME: "/scratch/config",
      XDG_CACHE_HOME: "/scratch/cache",
    })
  })

  it("on the virtual display: its switches and its display", () => {
    const options = launchOptions({ ...base, mode: "virtual" })

    expect(options.headless).toBe(false)
    expect(options.args).toEqual(expect.arrayContaining(displaySwitches()))
    expect(options.args?.join(" ")).not.toContain("--window-position")
    expect(options.env).toMatchObject({
      DISPLAY: ":7",
      XAUTHORITY: "/scratch/Xauthority",
    })
  })

  it("headless: nothing of a window", () => {
    const options = launchOptions({ ...base, mode: "headless", display: null })

    expect(options.headless).toBe(true)
    expect(options.args?.join(" ")).not.toContain("--window-position")
    expect(options.env).not.toHaveProperty("DISPLAY")
  })

  it("never with the automation switch, in any mode", () => {
    for (const mode of ["window", "virtual", "headless"] as const) {
      const options = launchOptions({ ...base, mode })
      expect(options.ignoreDefaultArgs).toEqual(["--enable-automation"])
      expect(options.args).toContain(
        "--disable-blink-features=AutomationControlled",
      )
      expect(options.chromiumSandbox).toBe(true)
    }
  })

  it("keeps an unseen window painting through patchright-core's own switches", () => {
    const bundle = readFileSync(
      createRequire(import.meta.url).resolve("patchright-core/lib/coreBundle"),
      "utf8",
    )
    const switches = bundle.match(
      /chromiumSwitches = \(options\) => \[([\s\S]*?)\]\.filter/,
    )?.[1]
    expect(switches).toBeDefined()

    // An off-screen window counts as covered; without these its page would
    // be hidden to its scripts and stop drawing, and the live view with it.
    for (const flag of [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ]) {
      expect(switches).toContain(`"${flag}"`)
      // Not repeated: patchright-core's are enough.
      expect(launchArgs("window")).not.toContain(flag)
    }
  })
})

describe("what a context starts with", () => {
  it("keeps Chromium's own user agent with a window, and replaces a headless one", () => {
    expect(contextOptions("153.0.7000.1", "window")).not.toHaveProperty(
      "userAgent",
    )
    expect(contextOptions("153.0.7000.1", "virtual")).not.toHaveProperty(
      "userAgent",
    )

    const headless = contextOptions("153.0.7000.1", "headless", "darwin")
    expect(headless.userAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    )
    expect(
      contextOptions("153.0.7000.1", "headless", "win32").userAgent,
    ).toContain("Windows NT 10.0; Win64; x64")
  })

  it("tells every page of a desktop's screen, larger than the page", () => {
    for (const mode of ["window", "virtual", "headless"] as const) {
      const options = contextOptions("153.0.7000.1", mode)
      expect(options.screen).toEqual(SCREEN)
      expect(options.viewport).toEqual({ width: 1280, height: 800 })
      expect(options.deviceScaleFactor).toBe(1)
    }
  })
})

/** A page's DevTools session, its window at `left`, `top`, as Chromium answers. */
function fakeSession({
  left,
  top = 40,
  windowState = "normal",
  clamped = false,
  failing = false,
}: {
  left: number
  top?: number
  windowState?: string
  clamped?: boolean
  failing?: boolean
}) {
  const sent: Array<{ method: string; params: unknown }> = []
  let bounds = { left, top, width: 1282, height: 880, windowState }

  const send = vi.fn(async (method: string, params?: unknown) => {
    sent.push({ method, params })
    if (failing) throw new Error("Browser window not found")

    switch (method) {
      case "Browser.getWindowForTarget":
        return { windowId: 7, bounds }
      case "Browser.setWindowBounds": {
        const asked = (params as { bounds: typeof bounds }).bounds
        if (!clamped) bounds = { ...bounds, ...asked }
        return {}
      }
      case "Browser.getWindowBounds":
        return { bounds }
      default:
        return {}
    }
  })

  return { cdp: { send } as unknown as CDPSession, sent }
}

describe("a window kept off the screen", () => {
  it("moves a window that is on the screen, keeping its size", async () => {
    const { cdp, sent } = fakeSession({ left: 100 })
    await keepOffScreen(cdp)

    expect(
      sent.find((call) => call.method === "Browser.setWindowBounds"),
    ).toEqual({
      method: "Browser.setWindowBounds",
      params: {
        windowId: 7,
        bounds: { left: OFF_SCREEN_WINDOW.x, top: OFF_SCREEN_WINDOW.y },
      },
    })
  })

  it("leaves one that is already there, and one that is not a normal window", async () => {
    for (const session of [
      fakeSession({ left: OFF_SCREEN_WINDOW.x, top: OFF_SCREEN_WINDOW.y }),
      fakeSession({ left: 0, windowState: "maximized" }),
    ]) {
      await keepOffScreen(session.cdp)
      expect(
        session.sent.some((call) => call.method === "Browser.setWindowBounds"),
      ).toBe(false)
    }
  })

  it("tells the page a place on its screen, with the screen patchright-core tells it", async () => {
    const { cdp, sent } = fakeSession({ left: 100 })
    await keepOffScreen(cdp)

    expect(
      sent.find((call) => call.method === "Emulation.setDeviceMetricsOverride")
        ?.params,
    ).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: SCREEN.width,
      screenHeight: SCREEN.height,
      screenOrientation: { angle: 0, type: "landscapePrimary" },
      positionX: SHOWN_WINDOW_POSITION.x,
      positionY: SHOWN_WINDOW_POSITION.y,
    })
  })

  it("never fails the page, and says once in the log what went wrong", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const holder = globalThis as Record<symbol, unknown>
    delete holder[Symbol.for("pcp.browser.offScreenWarned")]

    try {
      await expect(
        keepOffScreen(fakeSession({ left: 0, clamped: true }).cdp),
      ).resolves.toBeUndefined()
      await expect(
        keepOffScreen(fakeSession({ left: 0, failing: true }).cdp),
      ).resolves.toBeUndefined()

      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0]![0])).toContain(
        "could not be moved off the screen",
      )
    } finally {
      log.mockRestore()
      delete holder[Symbol.for("pcp.browser.offScreenWarned")]
    }
  })
})
