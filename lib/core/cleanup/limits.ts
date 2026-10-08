/**
 * The scheduled cleanup (lib/core/cleanup/): when it may run and how long
 * the request log may be kept.
 */

export type CleanupSchedule = {
  id: string
  label: string
  cron: string
}

/**
 * What the settings page offers. The minutes are off the hour so a cleanup
 * does not land on the same second as every other job on the machine.
 */
export const CLEANUP_SCHEDULES: readonly CleanupSchedule[] = [
  { id: "quarter-hour", label: "Every 15 minutes", cron: "*/15 * * * *" },
  { id: "hourly", label: "Every hour", cron: "7 * * * *" },
  { id: "six-hours", label: "Every 6 hours", cron: "7 */6 * * *" },
  { id: "daily", label: "Once a day, at 03:07", cron: "7 3 * * *" },
]

export const DEFAULT_CLEANUP_CRON = "7 * * * *"

/**
 * The longest a schedule may leave between two cleanups. Kept results are
 * promised gone a day after they were made, and a cleanup is what removes
 * them, so a custom schedule has to come round at least this often.
 */
export const MAX_CLEANUP_GAP_MS = 24 * 60 * 60_000

/** How far ahead a custom schedule is checked against that gap. */
export const CLEANUP_LOOKAHEAD_MS = 8 * 24 * 60 * 60_000

/** The runs read ahead to check a custom schedule. */
export const CLEANUP_LOOKAHEAD_RUNS = 400

export const MAX_CRON_CHARS = 100

/** Days of request log kept: today counts as one. */
export const DEFAULT_LOG_DAYS = 90
export const MIN_LOG_DAYS = 1
export const MAX_LOG_DAYS = 3650

/**
 * After a cleanup, the database file is rebuilt without its free pages
 * (lib/core/cleanup/space.ts) when they come to this much, or this share
 * of the file: less is not worth rewriting the file for.
 */
export const MIN_RECLAIM_BYTES = 32 * 1024 * 1024
export const MIN_RECLAIM_SHARE = 0.25

/** The owner's "Clean up now", per minute. */
export const CLEAN_NOW_LIMIT = { max: 5, windowMs: 60_000 }
