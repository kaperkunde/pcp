// The Touch ID key's file and the checks around it, apart from Electron so
// they can be tested (touch-id-store.test.mjs); touch-id.mjs wires them to
// Touch ID, the keychain and the window.
//
// The key is the one PCP made when the owner turned Touch ID on
// (lib/core/device-keys.ts): a random credential, not the password. The
// file holds it encrypted with safeStorage, whose key macOS keeps in the
// keychain for this app's code alone. It sits in the app's data folder next
// to desktop.json, outside the server's data directory: an export never
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
 * Whether a page is one of PCP's own, as the window shows it: plain http on
 * localhost, at the port the server listens on. Anything else the window
 * reaches (an OAuth provider's sign-in) gets no Touch ID.
 *
 * @param {string} url
 * @param {number} port
 */
export function isPcpPage(url, port) {
  try {
    return new URL(url).origin === `http://localhost:${port}`
  } catch {
    return false
  }
}
