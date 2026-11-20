import { randomUUID } from "node:crypto"

import { invalid, PcpError } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import { PCP_BUILT_AT, PCP_COMMIT, PCP_VERSION } from "../version"
import { removeInstallSignal, writeInstallSignal } from "./host-signal"
import {
  isUpdateChannel,
  releaseDownloadsUrl,
  releasePageUrl,
  type UpdateChannel,
} from "./limits"
import type { Release } from "./release"
import { isDevBuild, isNewer } from "./semver"

/**
 * What PCP remembers about updates, as host settings: they belong to the
 * machine, a timer reads them with nobody signed in, and nothing of the
 * vault is in them.
 *
 * `update.config` is the owner's choice and travels with an export, so a
 * check turned off stays off after a restore. `update.status` describes
 * this machine and never does.
 */

/**
 * How long an install request stays worth acting on (desktop/updates.mjs and
 * install.sh agree).
 */
export const INSTALL_REQUEST_FRESH_MS = 15 * 60_000

export const UPDATE_CONFIG_KEY = "update.config"
export const UPDATE_STATUS_KEY = "update.status"

export type UpdateConfig = {
  /** Look for a newer release by itself, once a day. */
  check: boolean
  /** Releases only, or develop's builds as well (./limits.ts). */
  channel: UpdateChannel
}

export type UpdateStatus = {
  lastCheckedAt?: string
  latest?: Release
  lastError?: string
  /** Consecutive failures, for the back-off. */
  failures?: number
  nextAttemptAt?: string
  /**
   * The owner asked the desktop app, or the Linux installer's watcher, to
   * install `version` (desktop/updates.mjs, install.sh).
   */
  installRequest?: { id: string; at: string; version: string }
  /**
   * The last install asked for, from which version to which: kept past the
   * restart that answers it (clearFinishedInstall lets go of
   * `installRequest` only), so whether it finished can be told after,
   * by the version that runs then (`lastInstallState`).
   */
  lastInstall?: LastInstall
}

export type LastInstall = { id: string; at: string; from: string; to: string }

/**
 * The channel when the owner has not picked one: the one this PCP came from,
 * so a build of develop keeps hearing of develop's builds.
 */
export function defaultChannel(version = PCP_VERSION): UpdateChannel {
  return isDevBuild(version) ? "develop" : "stable"
}

/** The check is on unless the owner turned it off. */
export async function getUpdateConfig(): Promise<UpdateConfig> {
  const stored = await getHostJson<{ check?: unknown; channel?: unknown }>(
    UPDATE_CONFIG_KEY,
  )

  return {
    check: typeof stored?.check === "boolean" ? stored.check : true,
    channel: isUpdateChannel(stored?.channel)
      ? stored.channel
      : defaultChannel(),
  }
}

/** Changes what it is given and keeps the rest. */
export async function saveUpdateConfig(
  change: Partial<UpdateConfig>,
): Promise<void> {
  const current = await getUpdateConfig()

  await setHostJson(UPDATE_CONFIG_KEY, {
    check: change.check ?? current.check,
    channel: change.channel ?? current.channel,
  })
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  return (await getHostJson<UpdateStatus>(UPDATE_STATUS_KEY)) ?? {}
}

export async function saveUpdateStatus(status: UpdateStatus): Promise<void> {
  await setHostJson(UPDATE_STATUS_KEY, status)
}

/** A newer release than this PCP, from what the last check found. */
export function newerRelease(status: UpdateStatus): Release | null {
  const latest = status.latest

  return latest && isNewer(latest.version, PCP_VERSION) ? latest : null
}

/** What the settings page shows. */
export type UpdatesOverview = {
  current: string
  check: boolean
  channel: UpdateChannel
  checkedAt: string | null
  error: string | null
  /** After a failure: when the timer asks again. */
  retryAt: string | null
  latest: (Release & { url: string }) | null
  /** `latest` is later than `current`. */
  available: boolean
  /** This PCP is a build of develop rather than a release. */
  devBuild: boolean
  /**
   * Where the desktop apps for what the owner would install are: the newer
   * build of develop's own files, else the latest release's.
   */
  downloads: string
  /** An install the owner asked for, while it is fresh. */
  installRequest: { id: string; at: string; version: string } | null
  /** The commit this build was made from and when, where it says (version.ts). */
  commit: string | null
  builtAt: string | null
}

type InstallRequest = NonNullable<UpdateStatus["installRequest"]>

function freshRequest(
  request: InstallRequest | undefined,
  now: Date,
): InstallRequest | null {
  return request &&
    now.getTime() - Date.parse(request.at) <= INSTALL_REQUEST_FRESH_MS &&
    isNewer(request.version, PCP_VERSION)
    ? request
    : null
}

/** The install the desktop app should start, if the owner asked for one just now. */
export async function pendingInstallRequest(
  now = new Date(),
): Promise<InstallRequest | null> {
  return freshRequest((await getUpdateStatus()).installRequest, now)
}

/**
 * The owner asks for the newer release the last check found. The desktop app
 * reads the request from /api/health; with `signalHost` it is also left in
 * the data folder for the Linux installer's watcher (./host-signal.ts), with
 * the channel when `signalChannel` says the installer reads one. PCP itself
 * installs nothing.
 */
export async function requestInstall(
  now = new Date(),
  {
    signalHost = false,
    signalChannel,
    version,
  }: {
    signalHost?: boolean
    signalChannel?: UpdateChannel
    /**
     * The version the owner was shown (update_pcp's request): installed only
     * while it is still the newest PCP knows of.
     */
    version?: string
  } = {},
): Promise<InstallRequest> {
  const status = await getUpdateStatus()
  const release = newerRelease(status)

  if (!release) {
    throw invalid(
      version
        ? `v${version} is not newer than this PCP, v${PCP_VERSION}, any more, so nothing was installed.`
        : "There is no newer version to install. Check now first.",
    )
  }

  if (version !== undefined && release.version !== version) {
    throw new PcpError(
      "state",
      `v${version} is no longer the newest version PCP knows of (v${release.version} is), so nothing was installed. Ask again for v${release.version}.`,
    )
  }

  const request = {
    id: randomUUID(),
    at: now.toISOString(),
    version: release.version,
  }
  await saveUpdateStatus({
    ...status,
    installRequest: request,
    lastInstall: {
      id: request.id,
      at: request.at,
      from: PCP_VERSION,
      to: request.version,
    },
  })
  if (signalHost) {
    await writeInstallSignal(request, signalChannel)
  }

  return request
}

/**
 * How the last install went, by the version that runs now: `finished` once
 * it is the one asked for, `installing` while the request is fresh, else
 * `not_finished` (the installer or the app did not get there in time).
 */
export type LastInstallState = LastInstall & {
  state: "finished" | "installing" | "not_finished"
}

export function lastInstallState(
  status: UpdateStatus,
  now = new Date(),
  version = PCP_VERSION,
): LastInstallState | null {
  const last = status.lastInstall

  if (!last) {
    return null
  }

  return {
    ...last,
    state:
      version === last.to
        ? "finished"
        : now.getTime() - Date.parse(last.at) <= INSTALL_REQUEST_FRESH_MS
          ? "installing"
          : "not_finished",
  }
}

/**
 * At boot: a request this version answers (or one too old to act on) is
 * done. The last install's record stays, so how it went can still be told.
 */
export async function clearFinishedInstall(now = new Date()): Promise<void> {
  const status = await getUpdateStatus()

  if (freshRequest(status.installRequest, now)) {
    return
  }
  if (status.installRequest) {
    await saveUpdateStatus({ ...status, installRequest: undefined })
  }
  await removeInstallSignal()
}

export async function updatesOverview(): Promise<UpdatesOverview> {
  const [config, status] = await Promise.all([
    getUpdateConfig(),
    getUpdateStatus(),
  ])

  return {
    current: PCP_VERSION,
    check: config.check,
    channel: config.channel,
    checkedAt: status.lastCheckedAt ?? null,
    error: status.lastError ?? null,
    retryAt: status.nextAttemptAt ?? null,
    latest: status.latest
      ? { ...status.latest, url: releasePageUrl(status.latest.version) }
      : null,
    available: newerRelease(status) !== null,
    devBuild: isDevBuild(PCP_VERSION),
    downloads: releaseDownloadsUrl(
      status.latest && isDevBuild(status.latest.version)
        ? status.latest.version
        : null,
    ),
    installRequest: freshRequest(status.installRequest, new Date()),
    commit: PCP_COMMIT,
    builtAt: PCP_BUILT_AT,
  }
}

/** For the header: the newer release, if the last check found one. */
export async function availableUpdate(): Promise<{
  version: string
  url: string
} | null> {
  const release = newerRelease(await getUpdateStatus())

  return release
    ? { version: release.version, url: releasePageUrl(release.version) }
    : null
}
