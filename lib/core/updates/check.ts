import { isPcpError } from "../errors"
import { describeFetchError } from "../openapi/http"
import {
  UPDATE_BACKOFF_MS,
  UPDATE_CHECK_EVERY_MS,
  UPDATE_FETCH_TIMEOUT_MS,
} from "./limits"
import { fetchLatestRelease } from "./release"
import type { UpdateStatus } from "./state"

/**
 * When the check runs, and what it keeps. The round reads and writes
 * nothing but what it is given, so it is tested with a fake fetch and a
 * clock, like the dynamic DNS one (network/ddns.ts).
 */

/**
 * Whether a check is due: a day after the last good one, or, after a
 * failure, when the back-off ends. The owner's "Check now" ignores both.
 */
export function updateDue(status: UpdateStatus, now: Date): boolean {
  if (status.nextAttemptAt) {
    return now.getTime() >= Date.parse(status.nextAttemptAt)
  }

  return (
    !status.lastCheckedAt ||
    now.getTime() - Date.parse(status.lastCheckedAt) >= UPDATE_CHECK_EVERY_MS
  )
}

/**
 * One round: asks GitHub if one is due (or `force`) and returns the status to
 * keep. When nothing was due it returns `status` itself, so the caller can
 * tell that there is nothing to save.
 */
export async function runUpdateRound({
  status,
  now,
  force = false,
  fetchFn = fetch,
  url,
}: {
  status: UpdateStatus
  now: Date
  force?: boolean
  fetchFn?: typeof fetch
  url?: string
}): Promise<UpdateStatus> {
  if (!force && !updateDue(status, now)) {
    return status
  }

  try {
    const latest = await fetchLatestRelease(fetchFn, url)

    return {
      ...status,
      lastCheckedAt: now.toISOString(),
      latest,
      lastError: undefined,
      failures: undefined,
      nextAttemptAt: undefined,
    }
  } catch (error) {
    const failures = (status.failures ?? 0) + 1
    const wait =
      UPDATE_BACKOFF_MS[Math.min(failures, UPDATE_BACKOFF_MS.length) - 1]

    return {
      ...status,
      lastCheckedAt: now.toISOString(),
      lastError: isPcpError(error)
        ? error.message
        : `PCP could not check for updates (${describeFetchError(error, UPDATE_FETCH_TIMEOUT_MS)}).`,
      failures,
      nextAttemptAt: new Date(now.getTime() + wait).toISOString(),
    }
  }
}
