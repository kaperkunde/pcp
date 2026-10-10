import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { DISPLAY_START_TIMEOUT_MS, SCREEN } from "./limits"

/**
 * A screen for the browser on a server: Chromium runs with a window on a
 * virtual display (Xvfb) instead of in its headless mode, as a desktop's
 * Chrome does. A site's check of its visitors sees a browser with a window
 * around the page and a screen of its own; headless, the window is exactly
 * the page.
 *
 * Only where it is asked for: in the container image (PCP_CONTAINER=1) by
 * default, or with PCP_BROWSER_DISPLAY=virtual on another Linux machine;
 * PCP_BROWSER_DISPLAY=headless turns it off. Never in the desktop app,
 * which runs on a real screen and starts no child process.
 *
 * One display per PCP process, started when the first browser starts and
 * stopped when the last one closes. Its socket takes only clients that
 * show the display's cookie, which PCP keeps in a private folder and hands
 * to Chromium alone, so another program on the machine cannot watch the
 * browser or type into it. A display that does not start leaves the
 * browser headless, as before.
 */

export type DisplaySetting = "auto" | "virtual" | "headless"

export type VirtualDisplay = {
  /** As DISPLAY takes it: ":99". */
  display: string
  /** The cookie file, as XAUTHORITY takes it. */
  authFile: string
}

type Running = VirtualDisplay & { process: ChildProcess; folder: string }

type DisplayState = {
  starting: Promise<Running | null> | null
  running: Running | null
  users: number
  /** Replaces the Xvfb command; for tests. */
  command: string | null
}

const DISPLAY = Symbol.for("pcp.browser.display")

function state(): DisplayState {
  const holder = globalThis as unknown as { [DISPLAY]?: DisplayState }

  holder[DISPLAY] ??= { starting: null, running: null, users: 0, command: null }
  return holder[DISPLAY]
}

/**
 * The features Playwright turns off in every Chromium it launches
 * (chromiumSwitches.ts in patchright-core). Chromium keeps only the last
 * --disable-features it is given, so a list of PCP's own has to carry
 * Playwright's too; display.test.ts checks this one against the
 * patchright-core installed.
 */
export const PLAYWRIGHT_DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
] as const

/**
 * Chromium's switches for a window on the virtual display.
 *
 * WebGL on Chromium's software renderer, which headless uses by itself:
 * without it a windowed Chromium on a display with no graphics card has no
 * WebGL at all.
 *
 * RenderDocument off: with it (Chromium 153), every navigation starts a new
 * document in a new frame, and a script that runs while that document loads
 * often sees a window of 0 by 0 at 0,0 (outerWidth, outerHeight, screenX,
 * screenY) until the window's place reaches it a moment later. A site's
 * check reads those as it loads, and 0 is what no desktop's Chrome shows.
 */
export function displaySwitches(): string[] {
  return [
    "--enable-unsafe-swiftshader",
    `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, "RenderDocument"].join(",")}`,
  ]
}

/** Uses another Xvfb command (a missing one, to test the fallback). */
export function setXvfbCommand(command: string | null): void {
  state().command = command
}

export function displaySetting(): DisplaySetting {
  const value = process.env.PCP_BROWSER_DISPLAY?.toLowerCase()
  return value === "virtual" || value === "headless" ? value : "auto"
}

/** Whether the browser should look for a virtual display here. */
export function wantsVirtualDisplay(): boolean {
  if (process.env.PCP_DESKTOP === "1" || process.platform !== "linux") {
    return false
  }

  const setting = displaySetting()
  return setting === "auto"
    ? process.env.PCP_CONTAINER === "1"
    : setting === "virtual"
}

/**
 * An Xauthority file with one cookie for every display on this machine
 * (FamilyWild), the format xauth writes: the X server reads it with -auth,
 * and Chromium with XAUTHORITY.
 */
function authEntry(cookie: Buffer): Buffer {
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length)
    return Buffer.concat([length, bytes])
  }
  const family = Buffer.alloc(2)
  family.writeUInt16BE(0xffff)

  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    field(cookie),
  ])
}

async function start(): Promise<Running | null> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pcp-display-"))
  const authFile = path.join(folder, "Xauthority")

  await fs.writeFile(authFile, authEntry(randomBytes(16)), { mode: 0o600 })

  const command = state().command ?? "Xvfb"
  const child = spawn(
    command,
    [
      // Xvfb picks a free display and writes its number to fd 3.
      "-displayfd",
      "3",
      "-screen",
      "0",
      `${SCREEN.width}x${SCREEN.height}x24`,
      "-nolisten",
      "tcp",
      "-auth",
      authFile,
      "-noreset",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe"] },
  )

  const number = await new Promise<string | null>((resolve) => {
    let text = ""
    const done = (value: string | null) => {
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), DISPLAY_START_TIMEOUT_MS)
    const pipe = child.stdio[3] as NodeJS.ReadableStream | null

    pipe?.on("data", (chunk: Buffer) => {
      text += chunk.toString()
      const line = text.match(/^(\d+)\n/)
      if (line) done(line[1]!)
    })
    child.once("error", () => done(null))
    child.once("exit", () => done(null))
  })

  if (number === null) {
    child.kill("SIGKILL")
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
    console.error(
      "[browser] the virtual display did not start; the browser runs headless",
    )
    return null
  }

  child.once("exit", () => {
    const current = state()
    if (current.running?.process === child) current.running = null
  })

  return { display: `:${number}`, authFile, process: child, folder }
}

function stop(running: Running): void {
  running.process.kill("SIGTERM")
  void fs.rm(running.folder, { recursive: true, force: true }).catch(() => {})
}

/**
 * The display for one browser, started if it is not running, and a way to
 * give it back: the display stops once every browser has given it back.
 * Null when it could not start (the browser then runs headless).
 */
export async function acquireDisplay(): Promise<{
  display: VirtualDisplay
  release: () => void
} | null> {
  const current = state()

  if (!current.running) {
    current.starting ??= start().finally(() => {
      current.starting = null
    })
    current.running = await current.starting
  }

  const running = current.running

  if (!running) {
    return null
  }

  current.users++
  let released = false

  return {
    display: { display: running.display, authFile: running.authFile },
    release: () => {
      if (released) return
      released = true
      current.users = Math.max(0, current.users - 1)

      if (current.users === 0 && current.running === running) {
        current.running = null
        stop(running)
      }
    },
  }
}

/** Whether a virtual display is running; for tests and the Browser page. */
export function runningDisplay(): VirtualDisplay | null {
  const running = state().running
  return running
    ? { display: running.display, authFile: running.authFile }
    : null
}
