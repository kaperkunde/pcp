import { pruneAllowances } from "../allowances"
import { pruneCallRecords } from "../calls/guard"
import { pruneEmbeddingVectors } from "../embeddings/index"
import { pruneFileLinks } from "../file-links"
import { pruneOAuthStates } from "../oauth"
import { pruneUnusedClients } from "../oauth-server/clients"
import { pruneOAuthCredentials } from "../oauth-server/tokens"
import { prunePermissionRequests, pruneReusableAnswers } from "../permissions"
import { pruneRequestLog } from "../request-log"
import { pruneLocalStores } from "../storage/cleanup"
import { pruneLinkCopies } from "../store-links"
import { pruneExpiredSessions } from "../sessions"
import { pruneToolResults } from "../tool-results"
import { pruneUploadLinks } from "../upload-links"
import { reclaimSpace, storesSpace } from "./space"
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
  run: (logDays: number, now: Date, freed: { bytes: number }) => Promise<number>
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
    // With the answers kept a little while for a call made again, and the
    // calls the duplicate guard remembers (calls/guard.ts).
    run: async (_, now) =>
      (await prunePermissionRequests(now)) +
      (await pruneReusableAnswers(now)) +
      (await pruneCallRecords(now)),
  },
  {
    key: "results",
    label: "kept results past their day",
    // With the links that move them, which last an hour (a store's file's
    // up to a week), and the upload pages the owner sends them from, kept
    // a day for check_upload.
    run: async (_, now, freed) => {
      const rows =
        (await pruneToolResults(now)) +
        (await pruneFileLinks(now)) +
        (await pruneUploadLinks(now))
      // The copies share_file made, once no link names them.
      const copies = await pruneLinkCopies(now)
      freed.bytes += copies.freedBytes
      return rows + copies.removed
    },
  },
  {
    key: "allowances",
    label: "ended time-limited allowances",
    run: (_, now) => pruneAllowances(now),
  },
  {
    key: "vectors",
    label: "search vectors no search used for a month",
    run: (_, now) => pruneEmbeddingVectors(now),
  },
  {
    key: "storage",
    label: "what PCP's own store left behind",
    run: async (_, now, freed) => {
      const { removed, freedBytes } = await pruneLocalStores(now)
      freed.bytes += freedBytes
      return removed
    },
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
    vectors: 0,
    storage: 0,
    logDays: 0,
  }
  const problems: string[] = []
  // Files a part removed from the data folder, beside the database's pages.
  const freed = { bytes: 0 }

  for (const part of PARTS) {
    try {
      removed[part.key] = await part.run(logDays, now, freed)
    } catch (error) {
      console.error(`[cleanup] could not remove ${part.label}`, error)
      problems.push(`Could not remove ${part.label}.`)
    }
  }

  // What was removed goes back to the disk, not only to SQLite's free list.
  let freedBytes = freed.bytes

  try {
    freedBytes += await reclaimSpace()
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
    ...(await storesSpace()),
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
