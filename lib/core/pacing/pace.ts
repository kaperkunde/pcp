import {
  MAX_PACED_DESTINATIONS,
  PACING_MAX_WAIT_MS,
  PACING_STATE_TTL_MS,
  type PacingPolicy,
} from "./limits"

/**
 * The pacing itself, in this process's memory: per vault and destination,
 * when its last action was given its slot and the slots inside the longest
 * burst window. Like the rate limiter it is not shared between replicas and
 * starts afresh on a restart; one of a few seconds is all it ever holds up.
 *
 * A caller is given its slot the moment it asks, in the order they ask
 * (JavaScript runs one at a time, so two callers never take the same one),
 * and then waits for it. The state is the slots given, not the actions
 * done: a call that waits its turn elsewhere (a tab's lane) after its slot
 * does not move the next one.
 */

/** Time and chance, replaced in tests. */
export type PacingClock = {
  now: () => number
  /** Waits `ms`, or rejects with the signal's reason when it aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** In [0, 1), as Math.random. */
  random: () => number
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

const REAL_CLOCK: PacingClock = {
  now: () => Date.now(),
  sleep,
  random: () => Math.random(),
}

type DestinationState = {
  /** The latest slot given, or null before the first. */
  last: number | null
  /** Slots given, oldest first, back to PACING_STATE_TTL_MS before the last. */
  slots: number[]
}

type Store = { clock: PacingClock; states: Map<string, DestinationState> }

const STORE = Symbol.for("pcp.pacing")

/** One per process, on globalThis as the browser's runtime is. */
function store(): Store {
  const holder = globalThis as unknown as { [STORE]?: Store }
  holder[STORE] ??= { clock: REAL_CLOCK, states: new Map() }
  return holder[STORE]
}

/** Tests: time and chance of their own, or the real ones again with null. */
export function setPacingClock(clock: Partial<PacingClock> | null): void {
  store().clock = clock ? { ...REAL_CLOCK, ...clock } : REAL_CLOCK
}

/** Tests: forget every destination. */
export function resetPacing(): void {
  store().states.clear()
}

/** A random extra wait in [0, jitterMs], whole milliseconds. */
export function jitterFor(jitterMs: number, random: () => number): number {
  if (jitterMs <= 0) {
    return 0
  }

  return Math.min(jitterMs, Math.floor(random() * (jitterMs + 1)))
}

function stateFor(key: string, now: number): DestinationState {
  const { states } = store()
  let state = states.get(key)

  if (state) {
    // Re-inserted so the Map's order is the order of last use.
    states.delete(key)
    states.set(key, state)
    return state
  }

  if (states.size >= MAX_PACED_DESTINATIONS) {
    for (const [old, value] of states) {
      if (value.last === null || value.last < now - PACING_STATE_TTL_MS) {
        states.delete(old)
      }
    }

    if (states.size >= MAX_PACED_DESTINATIONS) {
      const oldest = states.keys().next().value
      if (oldest !== undefined) states.delete(oldest)
    }
  }

  state = { last: null, slots: [] }
  states.set(key, state)
  return state
}

/** When the next action may go under `policy`, from `now`. */
function nextSlot(
  state: DestinationState,
  policy: PacingPolicy,
  now: number,
  random: () => number,
): number {
  let slot = now

  if (state.last !== null) {
    slot = Math.max(
      slot,
      state.last + policy.minIntervalMs + jitterFor(policy.jitterMs, random),
    )
  }

  const burst = policy.burst

  if (burst) {
    // Slots are given in order, so the list is sorted: the window's slots
    // are its tail.
    let first = state.slots.length

    while (first > 0 && state.slots[first - 1]! > slot - burst.perMs) {
      first--
    }

    const inWindow = state.slots.length - first

    if (inWindow >= burst.max) {
      // The earliest time at which only max - 1 of them are still inside.
      slot = Math.max(
        slot,
        state.slots[state.slots.length - burst.max]! + burst.perMs,
      )
    }
  }

  return slot
}

function prune(state: DestinationState): void {
  if (state.last === null) return
  const horizon = state.last - PACING_STATE_TTL_MS
  let drop = 0

  while (drop < state.slots.length && state.slots[drop]! <= horizon) {
    drop++
  }

  if (drop > 0) state.slots.splice(0, drop)
}

/** What a call too far from its turn is told, as a tool error. */
export function pacedMessage(label: string, waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000))
  return `Paced: ${label} takes its next action in ${seconds} s; try again then.`
}

/**
 * Waits for the destination's next slot under `policy`, and answers null
 * when the action may go. A slot further off than PACING_MAX_WAIT_MS is not
 * taken: the answer is then what to tell the caller. A signal that aborts
 * while the call waits rejects with its reason, and gives the slot back
 * when no later caller has taken one after it.
 */
export async function waitForSlot(
  key: string,
  label: string,
  policy: PacingPolicy,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string | null> {
  signal?.throwIfAborted()

  const { clock } = store()
  const now = clock.now()
  const state = stateFor(key, now)
  const slot = nextSlot(state, policy, now, clock.random)
  const waitMs = slot - now

  if (waitMs > PACING_MAX_WAIT_MS) {
    return pacedMessage(label, waitMs)
  }

  const before = state.last
  state.last = slot
  state.slots.push(slot)
  prune(state)

  if (waitMs <= 0) {
    return null
  }

  try {
    await clock.sleep(waitMs, signal)
  } catch (error) {
    if (state.last === slot && state.slots.at(-1) === slot) {
      state.slots.pop()
      state.last = before
    }

    throw error
  }

  return null
}
