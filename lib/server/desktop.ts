import "server-only"

/**
 * Whether this server was started by the desktop app (desktop/main.mjs sets
 * PCP_DESKTOP). The app listens on this computer only until its owner lets
 * other devices connect, from its menu, and the pages that explain how PCP
 * is reached say so. Nothing else depends on it.
 */
export function isDesktopApp(): boolean {
  return process.env.PCP_DESKTOP === "1"
}
