import path from "node:path"

import type {
  BrowserContextOptions,
  CDPSession,
  LaunchOptions,
} from "patchright-core"

import {
  displaySetting,
  displaySwitches,
  wantsVirtualDisplay,
  type Environment,
  type VirtualDisplay,
} from "./display"
import {
  OFF_SCREEN_WINDOW,
  SCREEN,
  SHOWN_WINDOW_POSITION,
  VIEWPORT,
} from "./limits"

/**
 * How Chromium runs, and what it is started with.
 *
 * - "virtual": with a window on PCP's virtual display (display.ts), in the
 *   container image.
 * - "window": with a window of its own on the machine's screen, kept off
 *   it: in the desktop app, and on a Mac or Windows machine otherwise.
 *   Chromium is still started by patchright-core, as a child of PCP's own
 *   process (in the desktop app, the server's utility process); a window
 *   changes only its switches, not how it is started.
 * - "headless": without a window, anywhere else, and where a window did
 *   not start.
 *
 * With a window, a site's check sees what it sees in a person's Chrome: a
 * window around the page, Chromium's own user agent and its complete client
 * hints. Headless, the window is exactly the page and the user agent has to
 * be replaced.
 */
export type BrowserMode = "virtual" | "window" | "headless"

/**
 * How the browser is wanted to run on this machine. What is running can
 * differ: a virtual display or a window that did not start leaves it
 * headless.
 */
export function wantedMode(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserMode {
  const setting = displaySetting(env)

  if (wantsVirtualDisplay(env, platform)) return "virtual"
  if (setting === "headless") return "headless"
  if (env.PCP_DESKTOP === "1") return "window"
  return platform === "darwin" || platform === "win32" ? "window" : "headless"
}

/**
 * Chromium's switches. Patchright-core adds its own (chromiumSwitches.ts),
 * among them the three that keep a window's page painting and its timers
 * running when no one can see it: --disable-backgrounding-occluded-windows
 * (an off-screen window counts as covered, and its page would otherwise be
 * hidden to its scripts and stop drawing, so the live view would freeze),
 * --disable-renderer-backgrounding and --disable-background-timer-throttling.
 * PCP adds none of those again; launch.test.ts checks they are there.
 */
export function launchArgs(mode: BrowserMode): string[] {
  return [
    "--disable-blink-features=AutomationControlled",
    ...(mode === "virtual" ? displaySwitches() : []),
    ...(mode === "window" ? windowSwitches() : []),
    // Two of Playwright's own switches that patchright-core leaves out and
    // PCP relies on: a page's script may open a window without a click
    // (the gate decides what loads in it), and a step back loads a
    // document again (the gate and the check watch see it), rather than
    // coming from the back-forward cache.
    "--disable-popup-blocking",
    "--disable-back-forward-cache",
    "--disable-dev-shm-usage",
    // UDP would go around the proxy: no QUIC, and WebRTC only through it.
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]
}

/**
 * A window of the browser's own, out of the owner's way: placed far to the
 * left of every screen. Not minimized: a minimized window's page is hidden
 * to its scripts (document.hidden), stops drawing and so stops the live
 * view, which an off-screen one does not (with the switch above). There is
 * no switch for a hidden window that is not headless (--start-minimized is
 * not one of Chromium's).
 *
 * macOS keeps a window's top edge on a screen but lets it leave sideways,
 * so the top stays on the main screen's top edge and the window goes left.
 * The position applies to every window Chromium opens by itself, a page's
 * popup aside; keepOffScreen moves each page's window there too, popups
 * included.
 *
 * No --window-size: patchright-core sizes each window to the viewport and
 * its frame as the page opens (Browser.setWindowBounds), so a size given
 * here would last only until then.
 */
function windowSwitches(): string[] {
  return [`--window-position=${OFF_SCREEN_WINDOW.x},${OFF_SCREEN_WINDOW.y}`]
}

/** What chromium.launch is given, but for the proxy and the timeout. */
export function launchOptions({
  mode,
  executablePath,
  sandbox,
  scratchDir,
  display,
  env = process.env,
}: {
  mode: BrowserMode
  executablePath: string
  sandbox: boolean
  scratchDir: string
  /** The virtual display, in "virtual" mode. */
  display: VirtualDisplay | null
  env?: Environment
}): LaunchOptions {
  return {
    executablePath,
    headless: mode === "headless",
    chromiumSandbox: sandbox,
    env: {
      ...env,
      XDG_CONFIG_HOME: path.join(scratchDir, "config"),
      XDG_CACHE_HOME: path.join(scratchDir, "cache"),
      ...(mode === "virtual" && display
        ? { DISPLAY: display.display, XAUTHORITY: display.authFile }
        : {}),
    },
    // What tells a page it is being driven: the automation switch and the
    // webdriver flag. The rest of Chromium is as it is.
    ignoreDefaultArgs: ["--enable-automation"],
    args: launchArgs(mode),
  }
}

/**
 * The modes to try, in order: a window that does not start (no screen to
 * open it on, a machine that refuses it) leaves the browser headless, as a
 * virtual display that does not start does.
 */
export function modesToTry(mode: BrowserMode): BrowserMode[] {
  return mode === "window" ? ["window", "headless"] : [mode]
}

function platformToken(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7"
    case "win32":
      return "Windows NT 10.0; Win64; x64"
    default:
      return "X11; Linux x86_64"
  }
}

/**
 * What every context starts with, the vault's and web_fetch's alike: a
 * desktop Chrome's user agent without "Headless", a screen larger than the
 * viewport as a desktop's is, the host's locale and time zone.
 *
 * With a window (on the virtual display or of its own) the browser keeps
 * its own user agent: overriding it makes Playwright send client hints
 * built from the string, with an empty platform version, which Chromium's
 * own never has. Headless the user agent says "HeadlessChrome" and has to
 * be replaced.
 *
 * Service workers are not an option here: a service worker can answer a
 * navigation without the network, around the gate, and the gate refuses
 * their scripts itself (isServiceWorkerScript). Playwright's own "block"
 * overwrote navigator.serviceWorker.register in every frame, which a page
 * can tell from the real one and go around through the prototype.
 */
export function contextOptions(
  browserVersion: string,
  mode: BrowserMode,
  platform: NodeJS.Platform = process.platform,
): BrowserContextOptions {
  const major = browserVersion.split(".")[0] || "141"
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions()

  return {
    viewport: { ...VIEWPORT },
    screen: { ...SCREEN },
    deviceScaleFactor: 1,
    ...(mode === "headless"
      ? {
          userAgent: `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        }
      : {}),
    locale,
    timezoneId: timeZone,
    acceptDownloads: false,
  }
}

const warned = Symbol.for("pcp.browser.offScreenWarned")

/** Says once per process what went wrong keeping a window off the screen. */
function warnOnce(message: string, error?: unknown): void {
  const holder = globalThis as unknown as { [warned]?: boolean }
  if (holder[warned]) return
  holder[warned] = true
  console.error(`[browser] ${message}`, ...(error ? [error] : []))
}

/**
 * Keeps a page's window off the owner's screen (mode "window"), and tells
 * the page its window is where a desktop's Chrome would put it.
 *
 * Its window is moved to OFF_SCREEN_WINDOW when it is anywhere else: a
 * popup opens where its page asked, on the screen, and moves off it here,
 * as it becomes a tab. Moving a window keeps its size.
 *
 * Off the screen, the page would read its window's place (screenX,
 * screenY) as thousands of pixels left of the screen it is told of, which
 * no person's window is. The page is told SHOWN_WINDOW_POSITION instead,
 * through the same emulation patchright-core sets the screen with
 * (Emulation.setDeviceMetricsOverride, its values repeated here, the
 * position added), on this page's own DevTools session: it lasts as long
 * as the session does, which is the tab's. Input PCP sends reports a screen
 * position from the page's own, whatever the window's place.
 *
 * Never fails the page: a window that stays where it is, or a page told
 * its real place, is said once in the log.
 */
export async function keepOffScreen(cdp: CDPSession): Promise<void> {
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget")

    if (
      bounds.windowState === "normal" &&
      (bounds.left !== OFF_SCREEN_WINDOW.x ||
        bounds.top !== OFF_SCREEN_WINDOW.y)
    ) {
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: OFF_SCREEN_WINDOW.x, top: OFF_SCREEN_WINDOW.y },
      })
      const moved = await cdp.send("Browser.getWindowBounds", { windowId })

      if (moved.bounds.left !== OFF_SCREEN_WINDOW.x) {
        warnOnce(
          `Chromium's window could not be moved off the screen: it is at ${moved.bounds.left},${moved.bounds.top}`,
        )
      }
    }

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: SCREEN.width,
      screenHeight: SCREEN.height,
      screenOrientation: { angle: 0, type: "landscapePrimary" },
      positionX: SHOWN_WINDOW_POSITION.x,
      positionY: SHOWN_WINDOW_POSITION.y,
    })
  } catch (error) {
    warnOnce("Chromium's window could not be kept off the screen", error)
  }
}
