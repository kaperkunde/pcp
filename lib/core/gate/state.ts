import {
  BACKOFF_MEMORY_MS,
  BASELINE_MIN,
  BASELINE_SAMPLES,
  COUNTER_BUCKET_MS,
  COUNTER_DAY_MS,
  MAX_GATED_PLACES,
  MAX_RETRY_AFTER_MS,
  SAMPLES_PER_BUCKET,
  SLOW_FACTOR,
  SLOW_FLOOR_MS,
  SLOW_RUN,
  type GateLimits,
} from "./limits"
import type { Throttle } from "./signals"

/**
 * The gate's state, in this process's memory (lib/core/gate/): per vault
 * and place, the calls running and waiting, whether it is cooling down,
 * and its counters. Like pacing's it is not shared between replicas and
 * starts afresh on a restart: a cool-down a restart forgets is found again
 * by the next throttle, and the counters say since when they count. Nothing
 * of a call is kept but its outcome, time and size, by place id.
 */

/** Time and chance, replaced in tests. */
export type GateClock = { now: () => number }

type Bucket = {
  /** Its start, a whole number of COUNTER_BUCKET_MS. */
  at: number
  calls: number
  errors: number
  throttles: number
  bytes: number
  /** Latencies in milliseconds, at most SAMPLES_PER_BUCKET. */
  ms: number[]
}

export type Cooling = {
  reason: string
  since: number
  until: number
}

type PlaceState = {
  label: string
  active: number
  /** The most at once, as the last caller's limits said. */
  max: number
  waiting: Array<() => void>
  cooling: Cooling | null
  /** How many cool-downs in a row (each one twice the last); -1 none. */
  level: number
  /** The latest successes' times, oldest first, for the usual time. */
  recent: number[]
  /** Slow answers in a row. */
  slow: number
  buckets: Bucket[]
  /** When this process started counting for it. */
  since: number
}

type Store = { clock: GateClock; places: Map<string, PlaceState> }

const STORE = Symbol.for("pcp.gate")

function store(): Store {
  const holder = globalThis as unknown as { [STORE]?: Store }
  holder[STORE] ??= { clock: { now: () => Date.now() }, places: new Map() }
  return holder[STORE]
}

/** Tests: a clock of their own, or the real one again with null. */
export function setGateClock(clock: GateClock | null): void {
  store().clock = clock ?? { now: () => Date.now() }
}

export function gateNow(): number {
  return store().clock.now()
}

/** Tests: forget every place. */
export function resetGate(): void {
  store().places.clear()
}

export function serverPlace(vaultId: string, serverId: string): string {
  return `${vaultId}\nserver:${serverId}`
}

export function sitePlace(vaultId: string, host: string): string {
  return `${vaultId}\nsite:${host}`
}

function placeFor(key: string, label: string): PlaceState {
  const { places, clock } = store()
  let state = places.get(key)

  if (state) {
    places.delete(key)
    places.set(key, state)
    state.label = label
    return state
  }

  if (places.size >= MAX_GATED_PLACES) {
    for (const [old, value] of places) {
      if (value.active === 0 && value.waiting.length === 0) {
        places.delete(old)
        break
      }
    }
  }

  state = {
    label,
    active: 0,
    max: 1,
    waiting: [],
    cooling: null,
    level: -1,
    recent: [],
    slow: 0,
    buckets: [],
    since: clock.now(),
  }
  places.set(key, state)
  return state
}

function peek(key: string): PlaceState | undefined {
  return store().places.get(key)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]!
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[index]!
}

/** The place's usual time: the median of its latest successes. */
function usual(state: PlaceState): number | null {
  return state.recent.length >= BASELINE_MIN ? median(state.recent) : null
}

/** A cool-down at the place now, or null; one that ended is dropped. */
export function coolingAt(key: string): Cooling | null {
  const state = peek(key)
  const cooling = state?.cooling

  if (!cooling) {
    return null
  }

  if (cooling.until <= gateNow()) {
    return null
  }

  return cooling
}

/** Starts (or lengthens) a cool-down at the place. */
function coolDown(
  state: PlaceState,
  limits: GateLimits,
  throttle: Throttle,
  now: number,
): void {
  const current = state.cooling

  if (current && current.until > now) {
    // Already cooling: the place's own word may lengthen it, nothing more.
    if (throttle.retryAfterMs !== undefined) {
      current.until = Math.max(current.until, now + throttle.retryAfterMs)
    }
    return
  }

  const recently = current !== null && now - current.until <= BACKOFF_MEMORY_MS
  state.level = recently ? state.level + 1 : 0
  const backoff = Math.min(
    limits.backoffMaxMs,
    limits.backoffBaseMs * 2 ** Math.min(state.level, 30),
  )
  const wait = Math.min(throttle.retryAfterMs ?? backoff, MAX_RETRY_AFTER_MS)

  state.cooling = { reason: throttle.reason, since: now, until: now + wait }
}

function bucketFor(state: PlaceState, now: number): Bucket {
  const at = now - (now % COUNTER_BUCKET_MS)
  const last = state.buckets.at(-1)

  if (last && last.at === at) {
    return last
  }

  const bucket: Bucket = {
    at,
    calls: 0,
    errors: 0,
    throttles: 0,
    bytes: 0,
    ms: [],
  }
  state.buckets.push(bucket)

  const horizon = now - COUNTER_DAY_MS
  let drop = 0
  while (drop < state.buckets.length && state.buckets[drop]!.at <= horizon) {
    drop++
  }
  if (drop > 0) state.buckets.splice(0, drop)

  return bucket
}

/** What a call came to, for the counters and the detector. */
export type CallEnd = {
  ok: boolean
  ms: number
  bytes?: number
  /** The place asked PCP to slow down. */
  throttle?: Throttle | null
  /** It ran past its time limit. */
  timedOut?: boolean
  /**
   * Whether a run of slow answers counts as a request to slow down; off
   * for sites, whose pages take as long as they take.
   */
  detectSlow?: boolean
}

/**
 * Counts a call and reads it for throttling: a throttle the place sent, or
 * a run of answers far slower than its usual time (or past their time
 * limit), starts a cool-down. A success at its usual pace once a cool-down
 * is over ends the run of them. Answers the cool-down it started, if any.
 */
export function recordEnd(
  key: string,
  label: string,
  limits: GateLimits,
  end: CallEnd,
): Cooling | null {
  const state = placeFor(key, label)
  const now = gateNow()
  const bucket = bucketFor(state, now)

  bucket.calls++
  if (!end.ok) bucket.errors++
  if (end.bytes) bucket.bytes += end.bytes
  if (bucket.ms.length < SAMPLES_PER_BUCKET) {
    bucket.ms.push(end.ms)
  } else {
    // Sampled: each later one replaces one at random, so a busy minute
    // still counts its slow calls.
    bucket.ms[Math.floor(Math.random() * SAMPLES_PER_BUCKET)] = end.ms
  }

  const base = usual(state)
  const slow =
    end.detectSlow !== false &&
    (end.timedOut === true ||
      (base !== null && end.ms >= Math.max(SLOW_FLOOR_MS, base * SLOW_FACTOR)))

  state.slow = slow ? state.slow + 1 : 0

  if (end.ok) {
    state.recent.push(end.ms)
    if (state.recent.length > BASELINE_SAMPLES) state.recent.shift()
  }

  let throttle = end.throttle ?? null

  if (!throttle && state.slow >= SLOW_RUN) {
    throttle = {
      reason: end.timedOut
        ? `${state.slow} calls in a row ran past its time limit`
        : `its answers are taking much longer than usual (${state.slow} in a row, about ${Math.round(end.ms / 1000)} s each${base !== null ? ` against ${Math.max(1, Math.round(base / 1000))} s` : ""})`,
    }
    state.slow = 0
  }

  if (throttle) {
    bucket.throttles++
    coolDown(state, limits, throttle, now)
    return state.cooling
  }

  // Back to normal: a success at its usual pace after the cool-down.
  if (end.ok && !slow && state.cooling && state.cooling.until <= now) {
    state.cooling = null
    state.level = -1
  }

  return null
}

/** Bytes the place answered over the last day, and when the oldest leave. */
export function bytesToday(key: string): { bytes: number; oldest: number } {
  const state = peek(key)
  const now = gateNow()
  let bytes = 0
  let oldest = now

  for (const bucket of state?.buckets ?? []) {
    if (bucket.at > now - COUNTER_DAY_MS && bucket.bytes > 0) {
      if (bytes === 0) oldest = bucket.at
      bytes += bucket.bytes
    }
  }

  return { bytes, oldest }
}

/**
 * When the answers counted against a day's bytes come down to under
 * `limit`: the time from now until enough of the oldest leave the day.
 */
export function bytesFreeIn(key: string, limit: number): number {
  const state = peek(key)
  const now = gateNow()
  let total = bytesToday(key).bytes

  for (const bucket of state?.buckets ?? []) {
    if (bucket.at <= now - COUNTER_DAY_MS || bucket.bytes === 0) continue
    total -= bucket.bytes
    if (total < limit) {
      return Math.max(1_000, bucket.at + COUNTER_DAY_MS - now)
    }
  }

  return COUNTER_DAY_MS
}

/** The usual time of a call at the place, or a second when not known. */
export function usualMs(key: string): number {
  const state = peek(key)
  return Math.max(1_000, (state && usual(state)) ?? 1_000)
}

/** Settles true when a turn came, false when `budget` ran out first. */
export async function acquire(
  key: string,
  label: string,
  max: number,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()

  const state = placeFor(key, label)
  state.max = max

  if (state.active < max && state.waiting.length === 0) {
    state.active++
    return true
  }

  if (budgetMs <= 0) {
    return false
  }

  return new Promise<boolean>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      // The slot was counted for us by pump().
      resolve(true)
    }
    const leave = () => {
      const index = state.waiting.indexOf(wake)
      if (index !== -1) state.waiting.splice(index, 1)
    }
    const onAbort = () => {
      clearTimeout(timer)
      leave()
      reject(signal!.reason)
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      leave()
      resolve(false)
    }, budgetMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    state.waiting.push(wake)
  })
}

function pump(state: PlaceState): void {
  while (state.active < state.max && state.waiting.length > 0) {
    state.active++
    state.waiting.shift()!()
  }
}

/** Gives a turn back; the next one waiting gets it. */
export function release(key: string): void {
  const state = peek(key)

  if (!state) {
    return
  }

  state.active = Math.max(0, state.active - 1)
  pump(state)
}

export type WindowCounts = {
  calls: number
  errors: number
  throttles: number
  bytes: number
  p50Ms: number | null
  p95Ms: number | null
}

export type PlaceView = {
  running: number
  waiting: number
  cooling: Cooling | null
  /** Since when this process counts for the place. */
  since: number
  minute: WindowCounts
  hour: WindowCounts
  day: WindowCounts
}

function counts(buckets: Bucket[], from: number): WindowCounts {
  const inside = buckets.filter((bucket) => bucket.at >= from)
  const ms = inside.flatMap((bucket) => bucket.ms)

  return {
    calls: inside.reduce((sum, bucket) => sum + bucket.calls, 0),
    errors: inside.reduce((sum, bucket) => sum + bucket.errors, 0),
    throttles: inside.reduce((sum, bucket) => sum + bucket.throttles, 0),
    bytes: inside.reduce((sum, bucket) => sum + bucket.bytes, 0),
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
  }
}

/** The place's state and counters now. */
export function placeView(key: string): PlaceView {
  const state = peek(key)
  const now = gateNow()
  const buckets = state?.buckets ?? []
  // This minute and the one before, so it is never a few seconds' worth.
  const minuteStart = now - (now % COUNTER_BUCKET_MS) - COUNTER_BUCKET_MS

  return {
    running: state?.active ?? 0,
    waiting: state?.waiting.length ?? 0,
    cooling: coolingAt(key),
    since: state?.since ?? now,
    minute: counts(buckets, minuteStart),
    hour: counts(buckets, now - 60 * 60_000),
    day: counts(buckets, now - COUNTER_DAY_MS),
  }
}

/** Ends a place's cool-down now (the owner's button). */
export function endCooling(key: string): void {
  const state = peek(key)

  if (state) {
    state.cooling = null
    state.level = -1
    state.slow = 0
  }
}
