// Touch ID for PCP's pages in the window, which reach it through the
// preload (preload.cjs) as window.pcpDesktop.touchId. The page asks; this
// side decides. A key goes back to the page only after Touch ID, and only to
// PCP's own page in this app's window: never to another site the window has
// gone to, never to a frame inside a page.
//
// What the key opens is PCP's business (lib/core/device-keys.ts), and where
// it is kept is touch-id-store.mjs's: a keychain item macOS opens only for a
// fingerprint when the app is signed for it (native/keychain), otherwise a
// file encrypted with safeStorage behind the app's own Touch ID prompt. The
// wrapper knows nothing else about it.

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { app, ipcMain, safeStorage, systemPreferences } from "electron"

import {
  forgetDeviceKey,
  isPcpPage,
  readDeviceKey,
  touchIdAnswers,
  writeDeviceKey,
} from "./touch-id-store.mjs"

/**
 * native/keychain as scripts/keychain.mjs built it: in the app's resources
 * when packaged, in native-staged/ from a checkout. Null off macOS, or when
 * it is not there or does not load; Touch ID then keeps the key in the file.
 *
 * @returns {import("./touch-id-store.mjs").KeychainModule | null}
 */
function loadKeychain() {
  if (process.platform !== "darwin") {
    return null
  }
  const built = app.isPackaged
    ? path.join(process.resourcesPath, "native", "pcp_keychain.node")
    : path.join(import.meta.dirname, "native-staged", "pcp_keychain.node")
  try {
    return createRequire(import.meta.url)(built)
  } catch {
    return null
  }
}

/**
 * @param {{
 *   file: string,
 *   port: () => number,
 *   window: () => import("electron").BrowserWindow | null,
 * }} options
 */
export function serveTouchId({ file, port, window }) {
  const answers = touchIdAnswers({
    keychain: loadKeychain(),
    file: {
      usable: () =>
        process.platform === "darwin" &&
        systemPreferences.canPromptTouchID() &&
        safeStorage.isEncryptionAvailable(),
      exists: () => existsSync(file),
      read: () =>
        readDeviceKey(file, (encrypted) =>
          safeStorage.decryptString(encrypted),
        ),
      write: (key) =>
        writeDeviceKey(file, key, (plain) => safeStorage.encryptString(plain)),
      forget: () => forgetDeviceKey(file),
    },
    prompt: async (reason) => {
      try {
        await systemPreferences.promptTouchID(reason)
        return true
      } catch {
        // Cancelled, failed, or the owner chose their password instead.
        return false
      }
    },
  })

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

  handle("touch-id:status", () => answers.status())
  handle("touch-id:unlock", (purpose) => answers.unlock(purpose))
  handle("touch-id:save", (key) => answers.save(key))
  handle("touch-id:forget", () => answers.forget())
}
