import "server-only"

import { isDesktopApp } from "./desktop"

/**
 * How this PCP was installed, for the Settings page to say how to update it:
 * the desktop app, the container image (the Dockerfile sets PCP_CONTAINER,
 * which a deploy tool building from it keeps), or a checkout run with
 * `pnpm start`. PCP never updates itself in a container or a checkout.
 */
export type InstallKind = "desktop" | "container" | "source"

export function installKind(): InstallKind {
  if (isDesktopApp()) {
    return "desktop"
  }

  return process.env.PCP_CONTAINER === "1" ? "container" : "source"
}

/**
 * Whether the Linux installer set this container up to update itself once a
 * day (`PCP_AUTO_UPDATE=1`, which install.sh also passes into the container).
 */
export function autoUpdated(): boolean {
  return process.env.PCP_AUTO_UPDATE === "1"
}

/**
 * Whether the Linux installer watches for the owner's "Install and restart"
 * (`PCP_HOST_UPDATER=1`, which install.sh passes into the container unless
 * PCP_UPDATE_BUTTON=0). The request goes in a file in the data folder that
 * the installer reads (lib/core/updates/host-signal.ts); PCP pulls and
 * restarts nothing itself.
 */
export function hostUpdater(): boolean {
  return process.env.PCP_HOST_UPDATER === "1"
}
