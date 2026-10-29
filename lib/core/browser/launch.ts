import path from "node:path"

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  LaunchOptions,
  Page,
} from "patchright-core"

import {
  displaySetting,
  displaySwitches,
  wantsVirtualDisplay,
  type Environment,
  type Renderer,
  type VirtualDisplay,
} from "./display"
import {
  ACTION_TIMEOUT_MS,
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
export function launchArgs(
  mode: BrowserMode,
  renderer: Renderer = "software",
): string[] {
  return [
    "--disable-blink-features=AutomationControlled",
    // The renderer is the virtual display's alone. With a window of its own
    // (the desktop app) Chromium draws with the machine's graphics card by
    // itself, and headless as Chromium decides.
    ...(mode === "virtual" ? displaySwitches(renderer) : []),
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
  renderer = "software",
  env = process.env,
}: {
  mode: BrowserMode
  executablePath: string
  sandbox: boolean
  scratchDir: string
  /** The virtual display, in "virtual" mode. */
  display: VirtualDisplay | null
  /** How Chromium draws on the virtual display (displayRenderer). */
  renderer?: Renderer
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
    args: launchArgs(mode, renderer),
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

/**
 * The options of a context whose tabs go out through an exit
 * (lib/core/exits/): the tabs' own, with a proxy of its own (PCP's, for
 * that exit, on loopback) in place of the browser's, and no storage state:
 * it starts from none of the vault's sign-ins, and nothing of it is saved.
 */
export function exitContextOptions(
  browserVersion: string,
  mode: BrowserMode,
  proxyPort: number,
  platform: NodeJS.Platform = process.platform,
): BrowserContextOptions {
  return {
    ...contextOptions(browserVersion, mode, platform),
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
  }
}

const warned = Symbol.for("pcp.browser.offScreenWarned")
const backgroundWarned = Symbol.for("pcp.browser.backgroundWarned")

/** Says once per process what went wrong with a window (once per `key`). */
function warnOnce(message: string, error?: unknown, key = warned): void {
  const holder = globalThis as unknown as Record<symbol, boolean | undefined>
  if (holder[key]) return
  holder[key] = true
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

/** Chromium's id of each context newBrowserContext made in "window" mode. */
const contextIds = new WeakMap<BrowserContext, string>()

/**
 * A new context, with its id in Chromium kept for openPage in "window"
 * mode. Playwright does not tell it, so it is the one
 * Target.getBrowserContexts lists after the context is made and did not
 * before. A context whose id is not found so opens its pages as Playwright
 * does (openPage).
 */
export async function newBrowserContext(
  browser: Browser,
  mode: BrowserMode,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  if (mode !== "window") return browser.newContext(options)

  const session = await browser.newBrowserCDPSession().catch(() => null)
  const ids = async (): Promise<string[]> =>
    session
      ? (await session.send("Target.getBrowserContexts")).browserContextIds
      : []

  try {
    const before = new Set(await ids().catch(() => []))
    const context = await browser.newContext(options)
    const added = (await ids().catch(() => [])).filter((id) => !before.has(id))

    if (added.length === 1) contextIds.set(context, added[0]!)
    return context
  } finally {
    await session?.detach().catch(() => {})
  }
}

/** What openPage asks of Chromium's DevTools, apart for its tests. */
export type BackgroundTargets = {
  /** The context's id in Chromium. */
  contextId: string
  /** Target.createTarget on the browser's own session: the target's id. */
  create: (params: {
    url: string
    browserContextId: string
    newWindow: true
    background: true
    left: number
    top: number
  }) => Promise<string>
  close: (targetId: string) => Promise<void>
  /** A page's target id, read on its own DevTools session. */
  targetOf: (page: Page) => Promise<string>
}

function backgroundTargets(context: BrowserContext): BackgroundTargets | null {
  const browser = context.browser()
  const contextId = contextIds.get(context)
  if (!browser || !contextId) return null

  const onBrowser = async <T>(
    send: (session: CDPSession) => Promise<T>,
  ): Promise<T> => {
    const session = await browser.newBrowserCDPSession()
    try {
      return await send(session)
    } finally {
      await session.detach().catch(() => {})
    }
  }

  return {
    contextId,
    create: (params) =>
      onBrowser(
        async (session) =>
          (await session.send("Target.createTarget", params)).targetId,
      ),
    close: (targetId) =>
      onBrowser(async (session) => {
        await session.send("Target.closeTarget", { targetId })
      }),
    targetOf: async (page) => {
      const session = await page.context().newCDPSession(page)
      try {
        return (await session.send("Target.getTargetInfo")).targetInfo.targetId
      } finally {
        await session.detach().catch(() => {})
      }
    },
  }
}

/**
 * A new, blank page of PCP's own: a tab, or a page read for web_fetch.
 *
 * With a window (mode "window"), in a window of its own opened in the
 * background. Playwright's newPage creates its target without `background`,
 * and Chromium then shows the window as the active one, which on macOS
 * makes Chromium the active app and takes the keyboard from the app the
 * owner is typing in, into a page an assistant may drive. Here the target
 * is created with `background` (Chromium shows its window inactive) and
 * `newWindow` (a background tab in a window it shares would be hidden, and
 * stop drawing), at OFF_SCREEN_WINDOW, and the page Playwright makes of it
 * is picked out by its target id. keepOffScreen still follows, as for every
 * page. A popup a page opens is Chromium's own and may still take the
 * focus; keepOffScreen moves it.
 *
 * Without a window there is no focus to take. Anything that goes wrong
 * here, said once in the log, opens the page as Playwright does.
 */
export async function openPage(
  context: BrowserContext,
  mode: BrowserMode,
  targets: BackgroundTargets | null = mode === "window"
    ? backgroundTargets(context)
    : null,
): Promise<Page> {
  if (mode !== "window") return context.newPage()

  if (!targets) {
    warnOnce(
      "Chromium's id for a browser context was not found: its pages open in front",
      undefined,
      backgroundWarned,
    )
    return context.newPage()
  }

  try {
    return await openInBackground(context, targets)
  } catch (error) {
    warnOnce(
      "A page could not be opened in the background: it opens in front",
      error,
      backgroundWarned,
    )
    return context.newPage()
  }
}

async function openInBackground(
  context: BrowserContext,
  targets: BackgroundTargets,
): Promise<Page> {
  // Every page from here on, the new one among them: Playwright may
  // announce it before createTarget answers or after.
  const fresh: Page[] = []
  let wake = () => {}
  const onPage = (page: Page) => {
    fresh.push(page)
    wake()
  }
  context.on("page", onPage)
  let targetId: string | null = null

  try {
    targetId = await targets.create({
      url: "about:blank",
      browserContextId: targets.contextId,
      newWindow: true,
      background: true,
      left: OFF_SCREEN_WINDOW.x,
      top: OFF_SCREEN_WINDOW.y,
    })
    const deadline = Date.now() + ACTION_TIMEOUT_MS

    for (;;) {
      for (let page = fresh.shift(); page; page = fresh.shift()) {
        const id = await targets.targetOf(page).catch(() => null)
        if (id === targetId) return page
      }

      const left = deadline - Date.now()
      if (left <= 0) throw new Error("Playwright did not take the page in")

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
        if (fresh.length) wake()
      })
      wake = () => {}
    }
  } catch (error) {
    // The window opened but is not PCP's to use: it goes.
    if (targetId) await targets.close(targetId).catch(() => {})
    throw error
  } finally {
    context.off("page", onPage)
  }
}
