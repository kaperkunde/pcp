import { createTask, validateDetailed } from "node-cron"

import { invalid } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import {
  CLEANUP_LOOKAHEAD_MS,
  CLEANUP_LOOKAHEAD_RUNS,
  CLEANUP_SCHEDULES,
  DEFAULT_CLEANUP_CRON,
  DEFAULT_LOG_DAYS,
  MAX_CLEANUP_GAP_MS,
  MAX_CRON_CHARS,
  MAX_LOG_DAYS,
  MIN_LOG_DAYS,
} from "./limits"

/**
 * What PCP remembers about the cleanup, as host settings: it is upkeep of
 * the machine, a timer reads it with nobody signed in, and nothing of the
 * vault is in it. `cleanup.config` is the owner's choice; `cleanup.status`
 * what the last run did. Neither travels with an export.
 */

export const CLEANUP_CONFIG_KEY = "cleanup.config"
export const CLEANUP_STATUS_KEY = "cleanup.status"

export type CleanupConfig = {
  /** When it runs: five cron fields, in this machine's time zone. */
  cron: string
  /** Days of request log kept, today included. */
  logDays: number
}

/** What one run removed. */
export type CleanupCounts = {
  sessions: number
  connections: number
  /**
   * What PCP's authorization server let expire: apps' codes and tokens, and
   * registrations no sign-in used. Missing from a status saved before it.
   */
  apps?: number
  requests: number
  results: number
  allowances: number
  logDays: number
}

export type CleanupStatus = {
  lastRunAt?: string
  /** What started it: PCP starting, the schedule, or the owner's "Clean up now". */
  trigger?: "start" | "schedule" | "owner"
  ms?: number
  removed?: CleanupCounts
  /** The parts that failed, said for the owner (the server log has why). */
  problems?: string[]
}

/** A schedule as the owner may set it, or why not. */
export function checkCron(value: string, now = new Date()): string {
  const cron = value.trim().replace(/\s+/g, " ")

  if (cron.length === 0) {
    throw invalid("Enter a schedule.")
  }

  if (cron.length > MAX_CRON_CHARS) {
    throw invalid(`A schedule is at most ${MAX_CRON_CHARS} characters.`)
  }

  // Five fields: minute, hour, day of month, month, day of week. node-cron
  // also reads a sixth for seconds, which would let a cleanup run every
  // second.
  if (cron.split(" ").length !== 5) {
    throw invalid(
      "A schedule has five fields: minute, hour, day of month, month and day of week, as in 7 * * * *.",
    )
  }

  const checked = validateDetailed(cron)

  if (!checked.valid) {
    const first = checked.errors[0]
    throw invalid(
      `That schedule does not work${first ? `: ${first.message}` : ""}.`,
    )
  }

  // Read ahead, and refuse a schedule that leaves more than a day between
  // two runs (a weekday-only one, a monthly one).
  const task = createTask(cron, () => {})

  try {
    const runs = task.getNextRuns(CLEANUP_LOOKAHEAD_RUNS)
    let previous = now.getTime()

    for (const run of runs) {
      if (run.getTime() - previous > MAX_CLEANUP_GAP_MS) {
        throw invalid(
          "That schedule leaves more than a day between two cleanups. Kept results are removed a day after they were made, so a cleanup has to run at least once a day.",
        )
      }

      previous = run.getTime()

      if (previous - now.getTime() > CLEANUP_LOOKAHEAD_MS) {
        break
      }
    }

    if (runs.length === 0) {
      throw invalid("That schedule never runs.")
    }
  } finally {
    void task.destroy()
  }

  return cron
}

export function checkLogDays(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_LOG_DAYS ||
    value > MAX_LOG_DAYS
  ) {
    throw invalid(
      `Keep the log for ${MIN_LOG_DAYS} to ${MAX_LOG_DAYS.toLocaleString("en")} days.`,
    )
  }

  return value
}

/** The owner's choice, or the defaults for what is missing or unreadable. */
export async function getCleanupConfig(): Promise<CleanupConfig> {
  const stored = await getHostJson<{ cron?: unknown; logDays?: unknown }>(
    CLEANUP_CONFIG_KEY,
  )
  let cron = DEFAULT_CLEANUP_CRON
  let logDays = DEFAULT_LOG_DAYS

  if (typeof stored?.cron === "string") {
    try {
      cron = checkCron(stored.cron)
    } catch {
      // A schedule this PCP no longer accepts falls back to the default
      // rather than leaving the cleanup off.
    }
  }

  if (typeof stored?.logDays === "number") {
    try {
      logDays = checkLogDays(stored.logDays)
    } catch {
      // As above.
    }
  }

  return { cron, logDays }
}

export async function saveCleanupConfig(config: CleanupConfig): Promise<void> {
  await setHostJson(CLEANUP_CONFIG_KEY, {
    cron: checkCron(config.cron),
    logDays: checkLogDays(config.logDays),
  })
}

export async function getCleanupStatus(): Promise<CleanupStatus> {
  return (await getHostJson<CleanupStatus>(CLEANUP_STATUS_KEY)) ?? {}
}

export async function saveCleanupStatus(status: CleanupStatus): Promise<void> {
  await setHostJson(CLEANUP_STATUS_KEY, status)
}

/** The preset a schedule is, or "custom". */
export function scheduleId(cron: string): string {
  return (
    CLEANUP_SCHEDULES.find((preset) => preset.cron === cron)?.id ?? "custom"
  )
}

const REMOVED: Array<[keyof CleanupCounts, string, string]> = [
  ["sessions", "ended sign-in", "ended sign-ins"],
  ["connections", "unfinished server sign-in", "unfinished server sign-ins"],
  ["apps", "expired app sign-in", "expired app sign-ins"],
  ["requests", "old permission request", "old permission requests"],
  ["results", "kept result past its day", "kept results past their day"],
  [
    "allowances",
    "ended time-limited allowance",
    "ended time-limited allowances",
  ],
  ["logDays", "day of log", "days of log"],
]

/** "3 ended sign-ins and 2 days of log", or null for nothing. */
export function describeRemoved(removed: CleanupCounts): string | null {
  const parts = REMOVED.filter(([key]) => (removed[key] ?? 0) > 0).map(
    ([key, one, many]) => `${removed[key]} ${removed[key] === 1 ? one : many}`,
  )

  if (parts.length === 0) {
    return null
  }

  return parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}
