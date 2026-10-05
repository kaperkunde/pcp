// Touch ID for PCP's pages in the window, which reach it through the
// preload (preload.cjs) as window.pcpDesktop.touchId. The page asks; this
// side decides. A key goes back to the page only after Touch ID, and only to
// PCP's own page in this app's window: never to another site the window has
// gone to, never to a frame inside a page.
//
// What the key opens is PCP's business (lib/core/device-keys.ts): the
// wrapper keeps it, encrypted with safeStorage (a key macOS keeps in the
// keychain for this app's code), and knows nothing else about it.

import { existsSync } from "node:fs"

import { ipcMain, safeStorage, systemPreferences } from "electron"

import {
  forgetDeviceKey,
  isDeviceKey,
  isPcpPage,
  readDeviceKey,
  TOUCH_ID_REASONS,
  writeDeviceKey,
} from "./touch-id-store.mjs"

/**
 * @param {{
 *   file: string,
 *   port: () => number,
 *   window: () => import("electron").BrowserWindow | null,
 * }} options
 */
export function serveTouchId({ file, port, window }) {
  // One prompt at a time: a second ask while one is showing is a no.
  let asking = false

  function available() {
    return (
      process.platform === "darwin" &&
      systemPreferences.canPromptTouchID() &&
      safeStorage.isEncryptionAvailable()
    )
  }

  /** @param {import("electron").IpcMainInvokeEvent} event */
  function fromPcp(event) {
    const shown = window()
    const frame = event.senderFrame

    return Boolean(
      shown &&
      !shown.isDestroyed() &&
      event.sender === shown.webContents &&
      frame &&
      frame === shown.webContents.mainFrame &&
      isPcpPage(frame.url, port()),
    )
  }

  /** @param {keyof typeof TOUCH_ID_REASONS} purpose */
  async function confirmed(purpose) {
    if (asking) {
      return false
    }

    asking = true

    try {
      await systemPreferences.promptTouchID(TOUCH_ID_REASONS[purpose])
      return true
    } catch {
      // Cancelled, failed, or the owner chose their password instead.
      return false
    } finally {
      asking = false
    }
  }

  /**
   * @param {string} channel
   * @param {(...args: unknown[]) => unknown} answer
   */
  function handle(channel, answer) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromPcp(event)) {
        throw new Error("Touch ID answers PCP's own pages only.")
      }

      return answer(...args)
    })
  }

  handle("touch-id:status", () => {
    const can = available()
    return { available: can, saved: can && existsSync(file) }
  })

  handle("touch-id:unlock", async (purpose) => {
    if (!available()) {
      return null
    }

    const key = readDeviceKey(file, (encrypted) =>
      safeStorage.decryptString(encrypted),
    )

    if (!key) {
      // Unreadable is as good as gone (macOS kept the keychain from this
      // build): PCP's Settings then offers to set Touch ID up again.
      forgetDeviceKey(file)
      return null
    }

    return (await confirmed(purpose === "confirm" ? "confirm" : "unlock"))
      ? key
      : null
  })

  handle("touch-id:save", async (key) => {
    if (!available() || !isDeviceKey(key) || !(await confirmed("save"))) {
      return false
    }

    writeDeviceKey(file, key, (plain) => safeStorage.encryptString(plain))
    return true
  })

  handle("touch-id:forget", () => {
    forgetDeviceKey(file)
  })
}
