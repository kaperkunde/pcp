import { schedule, type ScheduledTask } from "node-cron"

import { logUsage } from "../request-log"
import { CLEANUP_SCHEDULES } from "./limits"
import { runCleanup } from "./run"
import {
  describeRemoved,
  getCleanupConfig,
  getCleanupStatus,
  scheduleId,
  type CleanupConfig,
  type CleanupStatus,
} from "./state"

/**
 * The background side of the cleanup: one node-cron task per process, on
 * the owner's schedule, kept on globalThis because instrumentation.ts and
 * the Server Actions are bundled apart and would otherwise each have their
 * own copy of this module (and each their own task).
 *
 * Runs go one at a time, whatever starts them (PCP starting, the schedule,
 * the owner's "Clean up now"), and a run that fails is said in its status
 * and the server log; the next one tries again. The task is unref'd, so it
 * never keeps a process alive by itself.
 */

type Runtime = {
  started: boolean
  task: ScheduledTask | null
  /** The schedule the task runs on. */
  cron: string | null
  /** Runs and changes go one at a time. */
  chain: Promise<unknown>
}

const RUNTIME = Symbol.for("pcp.cleanup")

function runtime(): Runtime {
  const holder = globalThis as unknown as { [RUNTIME]?: Runtime }

  holder[RUNTIME] ??= {
    started: false,
    task: null,
    cron: null,
    chain: Promise.resolve(),
  }

  return holder[RUNTIME]
}

function chain<T>(run: () => Promise<T>): Promise<T> {
  const state = runtime()
  const result = state.chain.then(run, run)
  state.chain = result.catch((error) =>
    console.error("[cleanup] background work failed", error),
  )
  return result
}

/** One run, after any already under way. */
export function cleanUp(
  trigger: NonNullable<CleanupStatus["trigger"]>,
): Promise<CleanupStatus> {
  return chain(() => runCleanup(trigger))
}

/** At boot: one run now (as PCP always did), then the schedule. */
export async function startCleanup(): Promise<void> {
  const state = runtime()

  if (state.started) {
    return
  }

  state.started = true
  await cleanUp("start").catch((error) =>
    console.error("[cleanup] the first run failed", error),
  )
  await reconcileCleanup().catch((error) =>
    console.error("[cleanup] could not schedule", error),
  )
}

/** Makes the task match the owner's schedule. */
export function reconcileCleanup(): Promise<void> {
  return chain(async () => {
    const state = runtime()
    const { cron } = await getCleanupConfig()

    if (state.task && state.cron === cron) {
      return
    }

    await stopTask(state)
    state.task = schedule(cron, () => cleanUp("schedule"), {
      name: "pcp-cleanup",
      noOverlap: true,
      unref: true,
      // A run skipped while the machine slept is not worth a warning: the
      // next one removes the same rows.
      suppressMissedWarning: true,
    })
    state.cron = cron
  })
}

async function stopTask(state: Runtime): Promise<void> {
  const task = state.task
  state.task = null
  state.cron = null

  if (task) {
    await task.destroy()
  }
}

/** Ends the task (for tests). */
export function stopCleanup(): Promise<void> {
  return chain(async () => {
    const state = runtime()
    await stopTask(state)
    state.started = false
  })
}

/** The schedule the task runs on, or null with none (for tests). */
export function cleanupSchedule(): string | null {
  return runtime().cron
}

/** Resolves once the work started so far is done (for tests). */
export async function cleanupIdle(): Promise<void> {
  await runtime().chain
}

/** What the settings page shows. */
export type CleanupOverview = CleanupConfig & {
  /** The preset the schedule is, or "custom". */
  scheduleId: string
  /** The time zone the schedule is read in: this machine's. */
  timeZone: string
  nextRunAt: string | null
  status: CleanupStatus
  /** What the last run removed, in words, or null for nothing. */
  lastRemoved: string | null
  /** The schedules the page offers. */
  schedules: ReadonlyArray<{ id: string; label: string; cron: string }>
  log: { days: number; bytes: number; oldest: string | null }
}

export async function cleanupOverview(): Promise<CleanupOverview> {
  const [config, status, log] = await Promise.all([
    getCleanupConfig(),
    getCleanupStatus(),
    logUsage(),
  ])
  const state = runtime()
  const next =
    state.task && state.cron === config.cron ? state.task.getNextRun() : null

  return {
    ...config,
    scheduleId: scheduleId(config.cron),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nextRunAt: next ? next.toISOString() : null,
    status,
    lastRemoved: status.removed ? describeRemoved(status.removed) : null,
    schedules: CLEANUP_SCHEDULES,
    log,
  }
}
