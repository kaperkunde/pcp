import { isSetUp } from "../vault"
import { runUpdateRound } from "./check"
import { UPDATE_FIRST_TICK_MS, UPDATE_TICK_MS } from "./limits"
import {
  getUpdateConfig,
  getUpdateStatus,
  saveUpdateStatus,
  type UpdateStatus,
} from "./state"

/**
 * The background side of the update check: one timer per process, on while
 * the owner has not turned the check off. One per process, kept on
 * globalThis because instrumentation.ts and the Server Actions are bundled
 * apart and would otherwise each have their own copy of this module.
 *
 * The timer wakes every hour and a round runs only when one is due (a day
 * after the last good check), so a restart does not ask GitHub again. It
 * asks nothing before the owner has set up PCP, so they can read what it
 * does before it does it. With the check off there is no timer and no
 * request; "Check now" still works, because the owner pressed it.
 */

type Runtime = {
  started: boolean
  interval: NodeJS.Timeout | null
  first: NodeJS.Timeout | null
  /** Rounds run one at a time. */
  chain: Promise<unknown>
  /** Stand-in for fetch (for tests). */
  fetchFn: typeof fetch | undefined
}

const RUNTIME = Symbol.for("pcp.updates")

function runtime(): Runtime {
  const holder = globalThis as unknown as { [RUNTIME]?: Runtime }

  holder[RUNTIME] ??= {
    started: false,
    interval: null,
    first: null,
    chain: Promise.resolve(),
    fetchFn: undefined,
  }

  return holder[RUNTIME]
}

function chain<T>(run: () => Promise<T>): Promise<T> {
  const state = runtime()
  const result = state.chain.then(run, run)
  state.chain = result.catch((error) =>
    console.error("[updates] background work failed", error),
  )
  return result
}

/**
 * Keeps what a round owns and leaves the rest as it is now: a round takes
 * seconds, and the owner may have asked for an install meanwhile.
 */
function withRound(fresh: UpdateStatus, round: UpdateStatus): UpdateStatus {
  return {
    ...fresh,
    lastCheckedAt: round.lastCheckedAt,
    latest: round.latest,
    lastError: round.lastError,
    failures: round.failures,
    nextAttemptAt: round.nextAttemptAt,
  }
}

async function round(force: boolean): Promise<UpdateStatus> {
  const state = runtime()
  const status = await getUpdateStatus()
  const next = await runUpdateRound({
    status,
    now: new Date(),
    force,
    fetchFn: state.fetchFn,
  })

  if (next === status) {
    return status
  }

  const saved = withRound(await getUpdateStatus(), next)
  await saveUpdateStatus(saved)

  if (next.lastError) {
    console.error(`[updates] ${next.lastError}`)
  }

  return saved
}

/** A timer's turn: only for a PCP that is set up, with the check on (exported for tests). */
export function updateTick(): Promise<void> {
  return chain(async () => {
    if (!(await isSetUp()) || !(await getUpdateConfig()).check) {
      return
    }

    await round(false)
  })
}

/** At boot: starts the timer unless the owner turned the check off. */
export async function startUpdates(): Promise<void> {
  const state = runtime()

  if (state.started) {
    return
  }

  state.started = true
  await reconcileUpdates().catch((error) =>
    console.error("[updates] could not start", error),
  )
}

/** Makes the process match the setting: a timer while the check is on, none otherwise. */
export function reconcileUpdates(): Promise<void> {
  return chain(async () => {
    const state = runtime()
    const { check } = await getUpdateConfig()

    if (check) {
      state.interval ??= setInterval(
        () => void updateTick(),
        UPDATE_TICK_MS,
      ).unref()
      state.first ??= setTimeout(
        () => {
          state.first = null
          void updateTick()
        },
        UPDATE_FIRST_TICK_MS.min +
          Math.random() * (UPDATE_FIRST_TICK_MS.max - UPDATE_FIRST_TICK_MS.min),
      ).unref()
    } else {
      if (state.interval) clearInterval(state.interval)
      if (state.first) clearTimeout(state.first)
      state.interval = null
      state.first = null
    }
  })
}

/** The owner's "Check now": asks at once, whether or not the timer is on. */
export function checkNow(): Promise<UpdateStatus> {
  return chain(() => round(true))
}

/** Whether the timer is running (for tests). */
export function updateTimerActive(): boolean {
  return runtime().interval !== null
}

/** Resolves once the work started so far is done (for tests). */
export async function updatesIdle(): Promise<void> {
  await runtime().chain
}

/** Puts a stand-in for fetch in place, or the real one back (for tests). */
export function setUpdateFetch(fetchFn?: typeof fetch): void {
  runtime().fetchFn = fetchFn
}
