import { pruneAllowances } from "../allowances"
import { pruneOAuthStates } from "../oauth"
import { pruneUnusedClients } from "../oauth-server/clients"
import { pruneOAuthCredentials } from "../oauth-server/tokens"
import { prunePermissionRequests } from "../permissions"
import { pruneRequestLog } from "../request-log"
import { pruneExpiredSessions } from "../sessions"
import { pruneToolResults } from "../tool-results"
import { reclaimSpace } from "./space"
import {
  describeRemoved,
  getCleanupConfig,
  saveCleanupStatus,
  type CleanupCounts,
  type CleanupStatus,
} from "./state"

/**
 * One cleanup: everything PCP keeps only for a while, removed once its time
 * is up. Each part runs on its own, so one that fails (a log folder that
 * cannot be read) does not keep the others from running, and the run says
 * which part failed. Nothing here needs a credential: it deletes rows and
 * files by their dates, and reads nothing it deletes.
 */

type Part = {
  key: keyof CleanupCounts
  /** For the owner, when it fails. */
  label: string
  run: (logDays: number, now: Date) => Promise<number>
}

const PARTS: Part[] = [
  {
    key: "sessions",
    label: "ended sign-ins",
    run: () => pruneExpiredSessions(),
  },
  {
    key: "connections",
    label: "unfinished server sign-ins",
    run: () => pruneOAuthStates(),
  },
  {
    key: "apps",
    label: "expired app sign-ins",
    run: async (_, now) =>
      (await pruneOAuthCredentials(now)) + (await pruneUnusedClients(now)),
  },
  {
    key: "requests",
    label: "old permission requests",
    run: (_, now) => prunePermissionRequests(now),
  },
  {
    key: "results",
    label: "kept results past their day",
    run: (_, now) => pruneToolResults(now),
  },
  {
    key: "allowances",
    label: "ended time-limited allowances",
    run: (_, now) => pruneAllowances(now),
  },
  {
    key: "logDays",
    label: "old days of the log",
    run: (logDays, now) => pruneRequestLog(logDays, now),
  },
]

export async function runCleanup(
  trigger: NonNullable<CleanupStatus["trigger"]>,
  now = new Date(),
): Promise<CleanupStatus> {
  const started = Date.now()
  const { logDays } = await getCleanupConfig()
  const removed: CleanupCounts = {
    sessions: 0,
    connections: 0,
    apps: 0,
    requests: 0,
    results: 0,
    allowances: 0,
    logDays: 0,
  }
  const problems: string[] = []

  for (const part of PARTS) {
    try {
      removed[part.key] = await part.run(logDays, now)
    } catch (error) {
      console.error(`[cleanup] could not remove ${part.label}`, error)
      problems.push(`Could not remove ${part.label}.`)
    }
  }

  // What was removed goes back to the disk, not only to SQLite's free list.
  let freedBytes = 0

  try {
    freedBytes = await reclaimSpace()
  } catch (error) {
    console.error("[cleanup] could not give back disk space", error)
    problems.push("Could not give back the disk space it freed.")
  }

  const status: CleanupStatus = {
    lastRunAt: now.toISOString(),
    trigger,
    ms: Date.now() - started,
    removed,
    ...(freedBytes > 0 ? { freedBytes } : {}),
    ...(problems.length > 0 ? { problems } : {}),
  }

  await saveCleanupStatus(status)

  const said = describeRemoved(removed)

  if (said) {
    console.log(`[cleanup] removed ${said}`)
  }

  if (freedBytes > 0) {
    console.log(
      `[cleanup] gave back ${Math.round(freedBytes / 1024 / 1024)} MB of disk`,
    )
  }

  return status
}
