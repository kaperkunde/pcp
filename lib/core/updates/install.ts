import {
  COMPOSE_LINES,
  HOW_TO_UPDATE,
  installLine,
  SOURCE_LINES,
} from "@/lib/update-steps"

import { PcpError } from "../errors"
import { isDevBuild } from "./semver"
import { releaseDownloadsUrl, type UpdateChannel } from "./limits"
import { getUpdateConfig, requestInstall } from "./state"

/**
 * Whether this PCP can install an update itself, and how: one answer for the
 * owner's "Install and restart" (lib/actions/updates.ts) and for update_pcp
 * (./tools.ts), so the two never disagree.
 *
 * The desktop app installs one when its updater can ("auto",
 * desktop/updates.mjs); a container the Linux installer set up to watch for
 * the owner's request (PCP_HOST_UPDATER) has the installer do it. Anything
 * else (a container without it, a checkout, the app where macOS would refuse)
 * is updated by hand, as Settings → Updates says.
 */

/** How this PCP was installed, from what its host set when it started it. */
export type InstallHost = {
  kind: "desktop" | "container" | "source"
  /** The desktop app's updater: "auto" installs, "manual" only downloads. */
  desktopUpdater: "auto" | "manual"
  /** The Linux installer watches for the owner's request. */
  hostUpdater: boolean
  /** ...and installs from the channel the request names (develop too). */
  hostUpdaterFollowsChannel: boolean
  /** The Linux installer updates this container once a day by itself. */
  autoUpdated: boolean
}

/**
 * Read from the environment the host set: PCP_DESKTOP and
 * PCP_DESKTOP_UPDATER (desktop/main.mjs), PCP_CONTAINER (the Dockerfile),
 * PCP_HOST_UPDATER and PCP_AUTO_UPDATE (install.sh). lib/server's
 * install-kind.ts and desktop.ts read the same through this.
 */
export function installHost(
  env: Record<string, string | undefined> = process.env,
): InstallHost {
  const hostUpdater = env.PCP_HOST_UPDATER

  return {
    kind:
      env.PCP_DESKTOP === "1"
        ? "desktop"
        : env.PCP_CONTAINER === "1"
          ? "container"
          : "source",
    desktopUpdater: env.PCP_DESKTOP_UPDATER === "auto" ? "auto" : "manual",
    hostUpdater: hostUpdater === "1" || hostUpdater === "2",
    hostUpdaterFollowsChannel: hostUpdater === "2",
    autoUpdated: env.PCP_AUTO_UPDATE === "1",
  }
}

/** Why this PCP cannot install an update itself. */
export type CannotInstall =
  "desktop_manual" | "container" | "source" | "installer_releases_only"

export type InstallWay =
  | {
      can: true
      via: "desktop" | "installer"
      /** The request is also left in the data folder for the installer. */
      signalHost: boolean
      /** The channel, for an installer that reads one. */
      signalChannel?: UpdateChannel
    }
  | {
      can: false
      reason: CannotInstall
      /** What the owner's button says (Settings shows the steps beside it). */
      message: string
      /** The steps, as Settings → Updates gives them, for an assistant to pass on. */
      steps: string
    }

const CANNOT =
  "This PCP cannot install updates itself. Follow the steps under How to update this PCP."
const RELEASES_ONLY =
  "The installer on this computer installs releases only. To follow develop, run the install line under How to update this PCP once more, with PCP_CHANNEL=develop."

/** The one check: whether this PCP installs an update itself, on `channel`. */
export function installWay(
  host: InstallHost,
  channel: UpdateChannel,
  { version, latest }: { version?: string; latest?: string | null } = {},
): InstallWay {
  // install.sh remembers the channel, so going back to stable says so.
  const leaving = channel === "stable" && isDevBuild(version ?? "")

  if (host.kind === "desktop") {
    return host.desktopUpdater === "auto"
      ? { can: true, via: "desktop", signalHost: false }
      : {
          can: false,
          reason: "desktop_manual",
          message: CANNOT,
          steps: `${HOW_TO_UPDATE.desktopManual} The downloads: ${releaseDownloadsUrl(latest && isDevBuild(latest) ? latest : null)}`,
        }
  }

  // The installer watches wherever it says so (install.sh passes
  // PCP_HOST_UPDATER into the container it runs, and nothing else sets it).
  if (host.hostUpdater) {
    if (channel === "develop" && !host.hostUpdaterFollowsChannel) {
      return {
        can: false,
        reason: "installer_releases_only",
        message: RELEASES_ONLY,
        steps: `${HOW_TO_UPDATE.installerReleasesOnly} ${installLine("develop")}`,
      }
    }

    return {
      can: true,
      via: "installer",
      signalHost: true,
      ...(host.hostUpdaterFollowsChannel ? { signalChannel: channel } : {}),
    }
  }

  if (host.kind === "container") {
    return {
      can: false,
      reason: "container",
      message: CANNOT,
      steps: host.autoUpdated
        ? `${HOW_TO_UPDATE.containerAuto} To update at once, run the install line again: ${installLine(channel, { leaving })}`
        : `${HOW_TO_UPDATE.container} If it was installed with the install line, run it again: ${installLine(channel, { leaving })} From a checkout with docker compose: ${COMPOSE_LINES[channel]} ${HOW_TO_UPDATE.deployTool}`,
    }
  }

  return {
    can: false,
    reason: "source",
    message: CANNOT,
    steps: `${HOW_TO_UPDATE.source} ${SOURCE_LINES[channel]} ${HOW_TO_UPDATE.sourceRestart}`,
  }
}

/**
 * Installs the newest version PCP knows of, as the owner asked: on their
 * button, or on their yes to update_pcp's request (`version`, the one they
 * were shown, refused once it is no longer the newest). Throws the reason
 * this PCP cannot, or that nothing newer is known.
 */
export async function installNewest(
  host: InstallHost,
  { now = new Date(), version }: { now?: Date; version?: string } = {},
): Promise<{ version: string; via: "desktop" | "installer"; message: string }> {
  const { channel } = await getUpdateConfig()
  const way = installWay(host, channel)

  if (!way.can) {
    throw new PcpError("state", way.message)
  }

  const request = await requestInstall(now, {
    signalHost: way.signalHost,
    ...(way.signalChannel ? { signalChannel: way.signalChannel } : {}),
    ...(version !== undefined ? { version } : {}),
  })

  return {
    version: request.version,
    via: way.via,
    message:
      way.via === "desktop"
        ? `The app is downloading v${request.version}. PCP restarts by itself when it is done.`
        : `PCP is installing v${request.version}: the installer on this computer fetches it and starts PCP again, which takes a minute or two.`,
  }
}
