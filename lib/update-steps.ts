/**
 * How the owner updates PCP by hand, for the way it was installed: the lines
 * Settings → Updates shows under "How to update this PCP"
 * (components/updates-card.tsx) and the steps update_pcp answers with when
 * this PCP cannot install an update itself (lib/core/updates/install.ts).
 * One copy, so the two say the same. Pure: no imports, safe in the browser.
 */

export type StepsChannel = "stable" | "develop"

export const INSTALL_URL =
  "https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh"

/**
 * The install line, for the channel: install.sh remembers PCP_CHANNEL, so
 * the develop one says it every time and the stable one only when it is
 * leaving develop.
 */
export function installLine(
  channel: StepsChannel,
  { auto, leaving = false }: { auto?: boolean; leaving?: boolean } = {},
): string {
  const settings = [
    channel === "develop" || leaving ? `PCP_CHANNEL=${channel}` : null,
    auto === undefined ? null : `PCP_AUTO_UPDATE=${auto ? 1 : 0}`,
  ].filter(Boolean)

  return `curl -fsSL ${INSTALL_URL} | ${[...settings, "sh"].join(" ")}`
}

const SOURCE_BUILD = "pnpm install && pnpm db:generate && pnpm build"

export const SOURCE_LINES: Record<StepsChannel, string> = {
  stable: `git switch main && git pull && ${SOURCE_BUILD}`,
  develop: `git switch develop && git pull && ${SOURCE_BUILD}`,
}

export const COMPOSE_LINES: Record<StepsChannel, string> = {
  stable: "docker compose pull && docker compose up -d",
  develop:
    "PCP_TAG=develop docker compose pull && PCP_TAG=develop docker compose up -d",
}

/** The words for a PCP that cannot install an update itself, by how it runs. */
export const HOW_TO_UPDATE = {
  desktopManual:
    "This is the PCP app. Download the new version for this computer and open it. Your vault stays where it is.",
  container:
    "This PCP runs in a container. Updating means pulling the new image and starting the container again from it. Your vault is in the container's volume and stays.",
  containerAuto:
    "This PCP updates itself: the installer set up a daily update that fetches a new version and starts PCP again from it.",
  deployTool:
    "If a deploy tool runs it (Coolify, Portainer, a NAS app), redeploy it there. PCP itself never pulls an image or restarts its container.",
  source: "This PCP runs from a checkout. In its folder:",
  sourceRestart:
    "Then start it again (pnpm start, or the service you run it from). Your vault stays in its data folder.",
  installerReleasesOnly:
    "The installer on this computer installs releases only. To install it and follow develop from now on, run the install line with the develop channel:",
} as const
