// The app's side of "Install and restart" on PCP's Settings page. The page
// cannot reach this wrapper for it (its preload carries Touch ID alone: the
// window is otherwise a plain view of the server), so the server says what the
// owner asked for in /api/health and the wrapper reads it. These are the pure
// parts, tested in updates.test.mjs.

/** How long a request stays worth acting on, as the Settings page reckons it. */
export const INSTALL_REQUEST_FRESH_MS = 15 * 60_000

const VERSION = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** @param {string} text */
function parseVersion(text) {
  const match = VERSION.exec(String(text).trim())
  return match ? match.slice(1).map(Number) : null
}

/** Whether `candidate` is a later release than `current`; garbage never is. */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/**
 * Whether this build installs updates itself. dist.mjs writes `pcpUpdater`
 * into the packaged package.json: "auto" on Windows and on a signed Mac, where
 * the updater can replace the app, "manual" on an ad-hoc signed Mac, where
 * macOS refuses to. A checkout (`electron .`) is always manual.
 *
 * @param {{ pcpUpdater?: unknown }} pkg
 * @param {boolean} isPackaged
 * @returns {"auto" | "manual"}
 */
export function updaterMode(pkg, isPackaged) {
  return isPackaged && pkg?.pcpUpdater === "auto" ? "auto" : "manual"
}

/**
 * @typedef {{ id: string, at: string, version: string }} InstallRequest
 * @typedef {{ version: string | null, installRequest: InstallRequest | null }} Health
 */

/**
 * What /api/health says, or null when it is not PCP's answer.
 *
 * @param {string} text
 * @returns {Health | null}
 */
export function parseHealth(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || value.status !== "ok") return null

  const request = value.installRequest
  const valid =
    request &&
    typeof request === "object" &&
    typeof request.id === "string" &&
    typeof request.at === "string" &&
    !Number.isNaN(Date.parse(request.at)) &&
    parseVersion(request.version) !== null

  return {
    version: typeof value.version === "string" ? value.version : null,
    installRequest: valid
      ? { id: request.id, at: request.at, version: request.version }
      : null,
  }
}

/**
 * The install to start now, if any: one the owner asked for after this app
 * started (so a failed install, or the request that led to this very start,
 * is never acted on again), not handled yet, recent, and for a version later
 * than this one.
 *
 * @param {Health | null} health
 * @param {{ startedAt: number, handled: Set<string>, current: string, now?: number }} state
 * @returns {InstallRequest | null}
 */
export function pendingInstall(health, { startedAt, handled, current, now }) {
  const request = health?.installRequest
  if (!request || handled.has(request.id)) return null

  const at = Date.parse(request.at)
  if (at < startedAt) return null
  if ((now ?? Date.now()) - at > INSTALL_REQUEST_FRESH_MS) return null
  if (!isNewer(request.version, current)) return null

  return request
}
