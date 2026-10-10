// What Touch ID answers PCP's page, and where it keeps the key, apart from
// Electron so it can be tested (touch-id-store.test.mjs); touch-id.mjs wires
// it to Touch ID, the keychain and the window.
//
// The key is the one PCP made when the owner turned Touch ID on
// (lib/core/device-keys.ts): a random credential, not the password. It is
// kept one of two ways:
//
// - In a keychain item macOS opens only for a fingerprint (native/keychain),
//   when the app is signed with its keychain group, which takes the
//   provisioning profile (scripts/keychain-profile.mjs). Reading the item is
//   the Touch ID check, and nothing reads it without a finger.
// - Otherwise in touch-id.bin, encrypted with safeStorage, whose key macOS
//   keeps in the keychain for this app's code alone, handed out after the
//   app's own Touch ID prompt.
//
// Either way it stays out of the server's data directory: an export never
// sees it, and the server never reads it.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"

const KEY_PATTERN = /^pcp_device_[A-Za-z0-9_-]{43}$/

/** What touch-id.mjs shows in the system's Touch ID prompt, by purpose. */
export const TOUCH_ID_REASONS = {
  unlock: "unlock PCP",
  confirm: "confirm it is you in PCP",
  save: "turn on Touch ID for PCP",
}

/** @param {unknown} value @returns {value is string} */
export function isDeviceKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value)
}

/**
 * The key in the file, or null when there is none, or it cannot be
 * decrypted (macOS kept the keychain from this build), or it is not a key.
 *
 * @param {string} file
 * @param {(encrypted: Buffer) => string} decrypt
 * @returns {string | null}
 */
export function readDeviceKey(file, decrypt) {
  let encrypted
  try {
    encrypted = readFileSync(file)
  } catch {
    return null
  }

  try {
    const key = decrypt(encrypted)
    return isDeviceKey(key) ? key : null
  } catch {
    return null
  }
}

/**
 * Keeps a key, readable by this user alone; a crash midway leaves the old
 * file or the new one, never half of either.
 *
 * @param {string} file
 * @param {string} key
 * @param {(plain: string) => Buffer} encrypt
 */
export function writeDeviceKey(file, key, encrypt) {
  if (!isDeviceKey(key)) {
    throw new Error("That is not a Touch ID key.")
  }

  const partial = `${file}.partial`
  writeFileSync(partial, encrypt(key), { mode: 0o600 })
  renameSync(partial, file)
}

/** @param {string} file */
export function forgetDeviceKey(file) {
  rmSync(file, { force: true })
}

/**
 * The origin the window loads PCP from: plain http on 127.0.0.1, the address
 * the server binds (it is still that when the server also accepts other
 * devices). Never the name "localhost": Chromium may resolve it to ::1
 * first, where another program could listen on the same port and be shown as
 * PCP, with the sign-in cookie and the Touch ID key.
 *
 * @param {number} port
 */
export function pcpOrigin(port) {
  return `http://127.0.0.1:${port}`
}

/**
 * Whether a page is one of PCP's own, as the window shows it: that origin,
 * exactly. Anything else the window reaches (an OAuth provider's sign-in)
 * gets no Touch ID.
 *
 * @param {string} url
 * @param {number} port
 */
export function isPcpPage(url, port) {
  try {
    return new URL(url).origin === pcpOrigin(port)
  } catch {
    return false
  }
}

/** Keychain answers (Security's OSStatus) the decisions below look at. */
export const KEYCHAIN = {
  OK: 0,
  NOT_FOUND: -25300,
}

/**
 * @typedef {{
 *   status(): { biometrics: boolean, entitled: boolean, saved: boolean, stale: boolean, code: number },
 *   store(key: string): number,
 *   read(reason: string): Promise<{ code: number, key?: string }>,
 *   remove(): number,
 * }} KeychainModule
 *
 * @typedef {{
 *   usable(): boolean,
 *   exists(): boolean,
 *   read(): string | null,
 *   write(key: string): void,
 *   forget(): void,
 * }} KeyFile
 */

/**
 * Touch ID's four answers to PCP's page (status, unlock, save, forget), from
 * the keychain item when the app is entitled to it and from the file
 * otherwise. One Touch ID question at a time: a second while one is showing
 * is a no.
 *
 * @param {{
 *   keychain: KeychainModule | null,
 *   file: KeyFile,
 *   prompt: (reason: string) => Promise<boolean>,
 * }} options
 */
export function touchIdAnswers({ keychain, file, prompt }) {
  const inKeychain = Boolean(keychain?.status().entitled)
  let asking = false

  /** @template T @param {() => Promise<T>} ask @param {T} busy */
  async function oneAtATime(ask, busy) {
    if (asking) {
      return busy
    }
    asking = true
    try {
      return await ask()
    } finally {
      asking = false
    }
  }

  /** @param {unknown} purpose */
  const reasonFor = (purpose) =>
    TOUCH_ID_REASONS[purpose === "confirm" ? "confirm" : "unlock"]

  if (inKeychain && keychain) {
    // A key an earlier build kept in the file: Touch ID never shipped that
    // way, so it is set up again (PCP's Settings says so) rather than moved.
    file.forget()

    const status = () => {
      const now = keychain.status()
      if (now.saved && now.stale) {
        // A fingerprint was added or removed: macOS has voided the item.
        keychain.remove()
        return { available: now.biometrics, saved: false }
      }
      return { available: now.biometrics, saved: now.biometrics && now.saved }
    }

    return {
      mode: "keychain",
      status,
      unlock: (purpose) =>
        oneAtATime(async () => {
          if (!status().saved) {
            return null
          }
          const answer = await keychain.read(reasonFor(purpose))
          if (answer.code === KEYCHAIN.OK && isDeviceKey(answer.key)) {
            return answer.key
          }
          if (answer.code === KEYCHAIN.NOT_FOUND) {
            keychain.remove()
          }
          // Cancelled, the wrong finger, or no Touch ID just now: the item
          // stays, and the page asks for the password.
          return null
        }, null),
      save: (key) =>
        oneAtATime(async () => {
          if (!isDeviceKey(key) || !keychain.status().biometrics) {
            return false
          }
          if (keychain.store(key) !== KEYCHAIN.OK) {
            return false
          }
          // The owner's finger, and proof the item opens with it.
          const proof = await keychain.read(TOUCH_ID_REASONS.save)
          if (proof.code === KEYCHAIN.OK && proof.key === key) {
            return true
          }
          keychain.remove()
          return false
        }, false),
      forget: () => {
        keychain.remove()
        file.forget()
      },
    }
  }

  return {
    mode: "file",
    status: () => {
      const can = file.usable()
      return { available: can, saved: can && file.exists() }
    },
    unlock: (purpose) =>
      oneAtATime(async () => {
        if (!file.usable()) {
          return null
        }
        const key = file.read()
        if (!key) {
          // Unreadable is as good as gone (macOS kept the keychain from
          // this build): PCP's Settings then offers to set it up again.
          file.forget()
          return null
        }
        return (await prompt(reasonFor(purpose))) ? key : null
      }, null),
    save: (key) =>
      oneAtATime(async () => {
        if (
          !file.usable() ||
          !isDeviceKey(key) ||
          !(await prompt(TOUCH_ID_REASONS.save))
        ) {
          return false
        }
        file.write(key)
        return true
      }, false),
    forget: () => file.forget(),
  }
}
