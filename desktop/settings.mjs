// The wrapper's own settings: the port the server listens on and whether
// other devices may connect. They live in desktop.json in the app's data
// folder, next to the server's data directory, and are read once at start.
// Everything PCP itself remembers is in its database; this file is only what
// has to be known before the server is up.

import { readFileSync, writeFileSync } from "node:fs"
import os from "node:os"

export const DEFAULT_PORT = 3000

/** @typedef {{ port: number, acceptConnectionsFromNetwork: boolean, toldAboutTray: boolean }} Settings */

/**
 * Settings from the file's text, with anything missing or malformed replaced
 * by its default. The port falls back to a PORT in the environment (a start
 * from a terminal) before the default.
 *
 * @param {string | null} text
 * @param {NodeJS.ProcessEnv} env
 * @returns {Settings}
 */
export function parseSettings(text, env = {}) {
  let parsed = {}
  if (text) {
    try {
      const value = JSON.parse(text)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value
      }
    } catch {
      // Malformed: start from the defaults rather than refuse to start.
    }
  }

  return {
    port: validPort(parsed.port) ?? validPort(env.PORT) ?? DEFAULT_PORT,
    acceptConnectionsFromNetwork: parsed.acceptConnectionsFromNetwork === true,
    toldAboutTray: parsed.toldAboutTray === true,
  }
}

/** @param {unknown} value */
function validPort(value) {
  const port =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

/**
 * @param {string} file
 * @param {NodeJS.ProcessEnv} env
 * @returns {Settings}
 */
export function readSettings(file, env = process.env) {
  let text = null
  try {
    text = readFileSync(file, "utf8")
  } catch {
    // No file yet: the defaults.
  }
  return parseSettings(text, env)
}

/**
 * @param {string} file
 * @param {Settings} settings
 */
export function writeSettings(file, settings) {
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * This machine's IPv4 addresses on its networks (not loopback), the ones
 * another device on the same network reaches it at.
 *
 * @param {ReturnType<typeof os.networkInterfaces>} interfaces
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const addresses = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address)
      }
    }
  }
  return [...new Set(addresses)].sort()
}
