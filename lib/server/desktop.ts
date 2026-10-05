import "server-only"

/**
 * Whether this server was started by the desktop app (desktop/main.mjs sets
 * PCP_DESKTOP). The app listens on this computer only until its owner lets
 * other devices connect, from its menu, and the pages that explain how PCP
 * is reached say so, and Settings says how the app is updated.
 */
export function isDesktopApp(): boolean {
  return process.env.PCP_DESKTOP === "1"
}

/**
 * Whether the desktop app can install an update itself (desktop/updates.mjs):
 * "auto" on Windows and on a signed Mac, "manual" where macOS would refuse
 * (an ad-hoc signed build) and in a checkout. Settings offers "Install and
 * restart" only for "auto".
 */
export function desktopUpdater(): "auto" | "manual" {
  return process.env.PCP_DESKTOP_UPDATER === "auto" ? "auto" : "manual"
}
