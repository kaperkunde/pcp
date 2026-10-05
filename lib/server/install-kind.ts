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
