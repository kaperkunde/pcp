import { randomUUID } from "node:crypto"

import { invalid } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import { PCP_VERSION } from "../version"
import { releasePageUrl } from "./limits"
import type { Release } from "./release"
import { isNewer } from "./semver"

/**
 * What PCP remembers about updates, as host settings: they belong to the
 * machine, a timer reads them with nobody signed in, and nothing of the
 * vault is in them.
 *
 * `update.config` is the owner's choice and travels with an export, so a
 * check turned off stays off after a restore. `update.status` describes
 * this machine and never does.
 */

/** How long an install request stays worth acting on (desktop/updates.mjs agrees). */
export const INSTALL_REQUEST_FRESH_MS = 15 * 60_000

export const UPDATE_CONFIG_KEY = "update.config"
export const UPDATE_STATUS_KEY = "update.status"

export type UpdateConfig = {
  /** Look for a newer release by itself, once a day. */
  check: boolean
}

export type UpdateStatus = {
  lastCheckedAt?: string
  latest?: Release
  lastError?: string
  /** Consecutive failures, for the back-off. */
  failures?: number
  nextAttemptAt?: string
  /** The owner asked the desktop app to install `version` (see the desktop app's updater). */
  installRequest?: { id: string; at: string; version: string }
}

/** On unless the owner turned it off. */
export async function getUpdateConfig(): Promise<UpdateConfig> {
  const stored = await getHostJson<{ check?: unknown }>(UPDATE_CONFIG_KEY)

  return { check: typeof stored?.check === "boolean" ? stored.check : true }
}

export async function saveUpdateConfig(config: UpdateConfig): Promise<void> {
  await setHostJson(UPDATE_CONFIG_KEY, { check: config.check })
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
  checkedAt: string | null
  error: string | null
  /** After a failure: when the timer asks again. */
  retryAt: string | null
  latest: (Release & { url: string }) | null
  /** `latest` is later than `current`. */
  available: boolean
  /** An install the owner asked the desktop app for, while it is fresh. */
  installRequest: { id: string; at: string; version: string } | null
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
 * The owner asks the desktop app to install the newer release the last check
 * found. The app reads it from /api/health; PCP itself installs nothing.
 */
export async function requestInstall(
  now = new Date(),
): Promise<InstallRequest> {
  const status = await getUpdateStatus()
  const release = newerRelease(status)

  if (!release) {
    throw invalid("There is no newer version to install. Check now first.")
  }

  const request = {
    id: randomUUID(),
    at: now.toISOString(),
    version: release.version,
  }
  await saveUpdateStatus({ ...status, installRequest: request })

  return request
}

/** At boot: a request this version answers (or one too old to act on) is done. */
export async function clearFinishedInstall(now = new Date()): Promise<void> {
  const status = await getUpdateStatus()

  if (status.installRequest && !freshRequest(status.installRequest, now)) {
    await saveUpdateStatus({ ...status, installRequest: undefined })
  }
}

export async function updatesOverview(): Promise<UpdatesOverview> {
  const [config, status] = await Promise.all([
    getUpdateConfig(),
    getUpdateStatus(),
  ])

  return {
    current: PCP_VERSION,
    check: config.check,
    checkedAt: status.lastCheckedAt ?? null,
    error: status.lastError ?? null,
    retryAt: status.nextAttemptAt ?? null,
    latest: status.latest
      ? { ...status.latest, url: releasePageUrl(status.latest.version) }
      : null,
    available: newerRelease(status) !== null,
    installRequest: freshRequest(status.installRequest, new Date()),
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
