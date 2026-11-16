import type { Throttle } from "../throttle-signal"
import {
  BACKOFF_MEMORY_MS,
  BASELINE_MIN,
  BASELINE_SAMPLES,
  COUNTER_BUCKET_MS,
  COUNTER_DAY_MS,
  COUNTER_HOUR_MS,
  MAX_GATED_PLACES,
  MAX_TOOLS_TRACKED,
  SAMPLES_PER_BUCKET,
  SAMPLES_PER_HOUR,
  SLOW_FACTOR,
  SLOW_FLOOR_MS,
  SLOW_RUN,
  SLOWDOWN_EASE_AFTER,
  SLOWDOWN_MAX_LEVEL,
  SLOWDOWN_MEMORY_MS,
  type GateLimits,
} from "./limits"

/**
 * The gate's state, in this process's memory (lib/core/gate/): per vault
 * and place, the calls running and waiting, whether it is cooling down or
 * held until a rate limit resets, each tool's usual time, and its
 * counters. Like pacing's it is not shared between replicas and starts
 * afresh on a restart: a cool-down a restart forgets is found again by the
 * next throttle, and the counters say since when they count. Nothing of a
 * call is kept but its outcome, time and size, by place id and tool name.
 */

/** Time and chance, replaced in tests. */
export type GateClock = { now: () => number; random?: () => number }

type Bucket = {
  /** Its start: a whole minute, or a whole hour once merged. */
  at: number
  /** COUNTER_BUCKET_MS, or COUNTER_HOUR_MS once merged. */
  span: number
  calls: number
  errors: number
  throttles: number
  bytes: number
  /**
   * A sample of its answer times, each standing for `weight` calls: every
   * call had the same chance of being kept (reservoir sampling).
   */
  ms: number[]
  weight: number
}

export type Cooling = {
  reason: string
  since: number
  until: number
}

/**
 * A place that answers, but asked PCP to go slower (an answer marked
 * throttled) or answers far slower than usual: its calls still go, one at
 * a time, further apart and with a longer time limit (limits.ts
 * slowedLimits). Each such signal steps it up, to SLOWDOWN_MAX_LEVEL;
 * SLOWDOWN_EASE_AFTER clean answers in a row step it down.
 */
export type Slowing = {
  /** 1 to SLOWDOWN_MAX_LEVEL. */
  level: number
  reason: string
  since: number
}

type Slowdown = Slowing & {
  /** The last signal: past SLOWDOWN_MEMORY_MS it is over. */
  last: number
  /** Clean answers in a row since. */
  clean: number
}

/** What a call's end started at its place, for its answer to say. */
export type GateEffect =
  { kind: "cooling"; cooling: Cooling } | { kind: "slowing"; slowing: Slowing }

type ToolTimes = {
  /** Its latest successes' times, oldest first, for its usual time. */
  recent: number[]
  /** Its slow answers in a row. */
  slow: number
}

type PlaceState = {
  label: string
  active: number
  /** The most at once, as the last caller's limits said. */
  max: number
  waiting: Array<() => void>
  cooling: Cooling | null
  /** Calls wait until then: a rate limit with nothing left till it resets. */
  holdUntil: number
  /** How many cool-downs in a row (each one twice the last); -1 none. */
  level: number
  /** Going slower at the place's request: null when it is not. */
  slowdown: Slowdown | null
  /** Per tool, least recently used first. */
  tools: Map<string, ToolTimes>
  /** Calls past their time limit in a row, whatever the tool. */
  timeouts: number
  buckets: Bucket[]
  /** When this process started counting for it. */
  since: number
}

type Store = { clock: GateClock; places: Map<string, PlaceState> }

const STORE = Symbol.for("pcp.gate")
const REAL_CLOCK: GateClock = { now: () => Date.now() }

function store(): Store {
  const holder = globalThis as unknown as { [STORE]?: Store }
  holder[STORE] ??= { clock: REAL_CLOCK, places: new Map() }
  return holder[STORE]
}

/** Tests: a clock of their own, or the real one again with null. */
export function setGateClock(clock: GateClock | null): void {
  store().clock = clock ?? REAL_CLOCK
}

export function gateNow(): number {
  return store().clock.now()
}

function random(): number {
  return (store().clock.random ?? Math.random)()
}

/** Tests: forget every place. */
export function resetGate(): void {
  store().places.clear()
}

/** Tests: how many places are held. */
export function placeCount(): number {
  return store().places.size
}

export function serverPlace(vaultId: string, serverId: string): string {
  return `${vaultId}\nserver:${serverId}`
}

export function sitePlace(vaultId: string, host: string): string {
  return `${vaultId}\nsite:${host}`
}

/**
 * A place that may be dropped: idle, nothing waiting, not cooling down or
 * going slower.
 */
function droppable(state: PlaceState, now: number): boolean {
  return (
    state.active === 0 &&
    state.waiting.length === 0 &&
    !(state.cooling && state.cooling.until > now) &&
    !(state.slowdown && now - state.slowdown.last < SLOWDOWN_MEMORY_MS) &&
    state.holdUntil <= now
  )
}

function placeFor(key: string, label: string): PlaceState {
  const { places } = store()
  const now = gateNow()
  let state = places.get(key)

  if (state) {
    places.delete(key)
    places.set(key, state)
    state.label = label
    return state
  }

  if (places.size >= MAX_GATED_PLACES) {
    // The least recently used that may go; none goes while all are busy or
    // cooling down (limits.ts MAX_GATED_PLACES).
    for (const [old, value] of places) {
      if (droppable(value, now)) {
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
    holdUntil: 0,
    level: -1,
    slowdown: null,
    tools: new Map(),
    timeouts: 0,
    buckets: [],
    since: now,
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

/** A tool's usual time: the median of its latest successes, once known. */
function usual(times: ToolTimes): number | null {
  return times.recent.length >= BASELINE_MIN ? median(times.recent) : null
}

function toolTimes(state: PlaceState, tool: string): ToolTimes {
  let times = state.tools.get(tool)

  if (times) {
    state.tools.delete(tool)
  } else {
    times = { recent: [], slow: 0 }

    if (state.tools.size >= MAX_TOOLS_TRACKED) {
      const oldest = state.tools.keys().next().value
      if (oldest !== undefined) state.tools.delete(oldest)
    }
  }

  state.tools.set(tool, times)
  return times
}

/** A cool-down at the place now, or null; one that ended is dropped. */
export function coolingAt(key: string): Cooling | null {
  const cooling = peek(key)?.cooling

  return cooling && cooling.until > gateNow() ? cooling : null
}

/**
 * How much slower the place's calls go now, or null; one whose last
 * signal is past SLOWDOWN_MEMORY_MS is over.
 */
export function slowingAt(key: string): Slowing | null {
  const state = peek(key)
  const slowdown = state?.slowdown

  if (!slowdown) {
    return null
  }

  if (gateNow() - slowdown.last >= SLOWDOWN_MEMORY_MS) {
    state.slowdown = null
    return null
  }

  return {
    level: slowdown.level,
    reason: slowdown.reason,
    since: slowdown.since,
  }
}

/**
 * Steps the place's slowdown up (or starts it). Answers whether it just
 * started, for the call's answer to say so once.
 */
function slowDown(state: PlaceState, reason: string, now: number): boolean {
  const current = state.slowdown
  const said = reason.replace(/[.\s]+$/, "")

  if (current && now - current.last < SLOWDOWN_MEMORY_MS) {
    current.level = Math.min(SLOWDOWN_MAX_LEVEL, current.level + 1)
    current.reason = said
    current.last = now
    current.clean = 0
    return false
  }

  state.slowdown = { level: 1, reason: said, since: now, last: now, clean: 0 }
  return true
}

/** A clean answer: SLOWDOWN_EASE_AFTER in a row step the slowdown down. */
function easeOff(state: PlaceState): void {
  const current = state.slowdown

  if (!current) {
    return
  }

  current.clean++

  if (current.clean >= SLOWDOWN_EASE_AFTER) {
    current.level--
    current.clean = 0

    if (current.level <= 0) {
      state.slowdown = null
    }
  }
}

/** Until when calls to the place wait for a rate limit's reset, or 0. */
export function holdAt(key: string): number {
  const until = peek(key)?.holdUntil ?? 0
  return until > gateNow() ? until : 0
}

/** Starts (or lengthens) a cool-down at the place. */
function coolDown(
  state: PlaceState,
  limits: GateLimits,
  throttle: Throttle,
  now: number,
): void {
  const current = state.cooling
  // The place's own word is followed, but no further than its longest
  // cool-down.
  const asked =
    throttle.retryAfterMs === undefined
      ? undefined
      : Math.min(throttle.retryAfterMs, limits.backoffMaxMs)

  if (current && current.until > now) {
    // Already cooling: the place's own word may lengthen it, nothing more.
    if (asked !== undefined) {
      current.until = Math.max(current.until, now + asked)
    }
    return
  }

  const recently = current !== null && now - current.until <= BACKOFF_MEMORY_MS
  state.level = recently ? state.level + 1 : 0
  const backoff = Math.min(
    limits.backoffMaxMs,
    limits.backoffBaseMs * 2 ** Math.min(state.level, 30),
  )

  state.cooling = {
    reason: throttle.reason.replace(/[.\s]+$/, ""),
    since: now,
    until: now + (asked ?? backoff),
  }
}

/** Keeps one answer time in a bucket's sample, each call as likely. */
function sample(bucket: Bucket, ms: number): void {
  if (bucket.ms.length < SAMPLES_PER_BUCKET) {
    bucket.ms.push(ms)
    return
  }

  const slot = Math.floor(random() * bucket.calls)

  if (slot < SAMPLES_PER_BUCKET) {
    bucket.ms[slot] = ms
  }

  bucket.weight = bucket.calls / bucket.ms.length
}

/**
 * Minute buckets past the last hour, merged into one per hour: counts
 * added, and a sample of their times drawn by weight (each kept time
 * standing for as many calls as before).
 */
function merge(minutes: Bucket[], at: number): Bucket {
  const keyed = minutes.flatMap((bucket) =>
    bucket.ms.map((ms) => ({
      ms,
      // Weighted sampling without replacement (Efraimidis–Spirakis).
      key: random() ** (1 / Math.max(bucket.weight, 1)),
    })),
  )
  keyed.sort((a, b) => b.key - a.key)
  const calls = minutes.reduce((sum, bucket) => sum + bucket.calls, 0)
  const kept = keyed.slice(0, SAMPLES_PER_HOUR).map((entry) => entry.ms)

  return {
    at,
    span: COUNTER_HOUR_MS,
    calls,
    errors: minutes.reduce((sum, bucket) => sum + bucket.errors, 0),
    throttles: minutes.reduce((sum, bucket) => sum + bucket.throttles, 0),
    bytes: minutes.reduce((sum, bucket) => sum + bucket.bytes, 0),
    ms: kept,
    weight: kept.length > 0 ? calls / kept.length : 1,
  }
}

/** Drops what is past a day and merges what is past an hour. */
function tidy(state: PlaceState, now: number): void {
  const dayAgo = now - COUNTER_DAY_MS
  const hourStart = now - (now % COUNTER_HOUR_MS) - COUNTER_HOUR_MS
  const kept: Bucket[] = []
  let pending: Bucket[] = []
  let pendingHour = -1

  const flush = () => {
    if (pending.length > 0) {
      kept.push(merge(pending, pendingHour))
      pending = []
    }
  }

  for (const bucket of state.buckets) {
    if (bucket.at + bucket.span <= dayAgo) {
      continue
    }

    if (bucket.span === COUNTER_BUCKET_MS && bucket.at < hourStart) {
      const hour = bucket.at - (bucket.at % COUNTER_HOUR_MS)
      if (hour !== pendingHour) flush()
      pendingHour = hour
      pending.push(bucket)
      continue
    }

    flush()
    kept.push(bucket)
  }

  flush()
  state.buckets = kept
}

function bucketFor(state: PlaceState, now: number): Bucket {
  const at = now - (now % COUNTER_BUCKET_MS)
  const last = state.buckets.at(-1)

  if (last && last.at === at && last.span === COUNTER_BUCKET_MS) {
    return last
  }

  const bucket: Bucket = {
    at,
    span: COUNTER_BUCKET_MS,
    calls: 0,
    errors: 0,
    throttles: 0,
    bytes: 0,
    ms: [],
    weight: 1,
  }
  state.buckets.push(bucket)
  tidy(state, now)
  return bucket
}

/** What a call came to, for the counters and the detector. */
export type CallEnd = {
  ok: boolean
  ms: number
  /** The tool called: its usual time is its own. */
  tool?: string
  bytes?: number
  /** The place asked PCP to slow down (or to wait for a reset: `hold`). */
  throttle?: Throttle | null
  /** It ran past its time limit. */
  timedOut?: boolean
  /**
   * What counts as slowing down here (limits.ts SLOW_DETECTION); "latency"
   * when left out.
   */
  detect?: "latency" | "timeouts" | "none"
}

/**
 * A place's "slow down" that came after its call ran past its time limit
 * (counted then): it still counts, so the next calls go slower (or, for a
 * refusal, wait out a cool-down) rather than run into the limit too.
 */
export function recordLateThrottle(
  key: string,
  label: string,
  limits: GateLimits,
  throttle: Throttle,
): GateEffect | null {
  if (throttle.hold) {
    return null
  }

  const state = placeFor(key, label)
  const now = gateNow()
  bucketFor(state, now).throttles++
  return signal(state, limits, throttle, now)
}

/**
 * A place's signal: "go slower" (an answer it marked throttled, or its
 * answers far slower than usual) steps its slowdown up and lets its calls
 * through; a refusal cools it down, and its calls go slower after.
 */
function signal(
  state: PlaceState,
  limits: GateLimits,
  throttle: Throttle,
  now: number,
): GateEffect | null {
  const started = slowDown(state, throttle.reason, now)

  if (throttle.slow) {
    return started
      ? { kind: "slowing", slowing: slowingOf(state.slowdown!) }
      : null
  }

  coolDown(state, limits, throttle, now)
  return state.cooling ? { kind: "cooling", cooling: state.cooling } : null
}

function slowingOf(slowdown: Slowdown): Slowing {
  return {
    level: slowdown.level,
    reason: slowdown.reason,
    since: slowdown.since,
  }
}

/**
 * Counts a call and reads it for throttling. A refusal the place sent
 * starts a cool-down (and its calls go slower after); its "go slower" (an
 * answer marked throttled), a run of calls past their time limit, or
 * (where latency counts) a run of one tool's answers far slower than its
 * usual time, makes its calls go slower without refusing any; a hold makes
 * the next calls wait for the reset. Clean answers ease the slowdown off,
 * and a success at its usual pace once a cool-down is over ends the run of
 * them. Answers what it started, if anything.
 */
export function recordEnd(
  key: string,
  label: string,
  limits: GateLimits,
  end: CallEnd,
): GateEffect | null {
  const state = placeFor(key, label)
  const now = gateNow()
  const bucket = bucketFor(state, now)
  const detect = end.detect ?? "latency"

  bucket.calls++
  if (!end.ok) bucket.errors++
  if (end.bytes) bucket.bytes += end.bytes
  sample(bucket, end.ms)

  const times = toolTimes(state, end.tool ?? "")
  const base = usual(times)
  const slowAnswer =
    detect === "latency" &&
    !end.timedOut &&
    base !== null &&
    end.ms >= Math.max(SLOW_FLOOR_MS, base * SLOW_FACTOR)

  times.slow = slowAnswer ? times.slow + 1 : 0
  state.timeouts =
    detect !== "none" && end.timedOut === true ? state.timeouts + 1 : 0

  if (end.ok) {
    times.recent.push(end.ms)
    if (times.recent.length > BASELINE_SAMPLES) times.recent.shift()
  }

  let throttle = end.throttle ?? null

  if (throttle?.hold) {
    // Wait for the reset; nothing cools down.
    const wait = Math.min(throttle.retryAfterMs ?? 0, limits.backoffMaxMs)
    state.holdUntil = Math.max(state.holdUntil, now + wait)
    throttle = null
  }

  if (!throttle && state.timeouts >= SLOW_RUN) {
    throttle = {
      reason: `${state.timeouts} calls in a row ran past its time limit`,
      slow: true,
    }
    state.timeouts = 0
  } else if (!throttle && times.slow >= SLOW_RUN) {
    throttle = {
      reason: `its answers${end.tool ? ` to ${end.tool}` : ""} are taking much longer than usual (${times.slow} in a row, about ${Math.round(end.ms / 1000)} s each against ${Math.max(1, Math.round(base! / 1000))} s)`,
      slow: true,
    }
    times.slow = 0
  }

  if (throttle) {
    bucket.throttles++
    return signal(state, limits, throttle, now)
  }

  if (end.ok && !slowAnswer && !end.timedOut) {
    easeOff(state)

    // Back to normal: a success at its usual pace after the cool-down.
    if (state.cooling && state.cooling.until <= now) {
      state.cooling = null
      state.level = -1
    }
  }

  return null
}

/** Bytes the place answered over the last day. */
export function bytesToday(key: string): number {
  const now = gateNow()

  return (peek(key)?.buckets ?? [])
    .filter((bucket) => bucket.at + bucket.span > now - COUNTER_DAY_MS)
    .reduce((sum, bucket) => sum + bucket.bytes, 0)
}

/**
 * When the answers counted against a day's bytes come down to under
 * `limit`: the time from now until enough of the oldest leave the day.
 */
export function bytesFreeIn(key: string, limit: number): number {
  const now = gateNow()
  let total = bytesToday(key)

  for (const bucket of peek(key)?.buckets ?? []) {
    if (bucket.at + bucket.span <= now - COUNTER_DAY_MS || bucket.bytes === 0) {
      continue
    }

    total -= bucket.bytes

    if (total < limit) {
      return Math.max(1_000, bucket.at + bucket.span + COUNTER_DAY_MS - now)
    }
  }

  return COUNTER_DAY_MS
}

/** A tool's usual time at the place, or a second when not known. */
export function usualMs(key: string, tool = ""): number {
  const times = peek(key)?.tools.get(tool)
  return Math.max(1_000, (times && usual(times)) ?? 1_000)
}

function pump(state: PlaceState): void {
  while (state.active < state.max && state.waiting.length > 0) {
    state.active++
    state.waiting.shift()!()
  }
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
  // A limit raised since lets those waiting in first.
  pump(state)

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
  slowing: Slowing | null
  /** Since when this process counts for the place. */
  since: number
  minute: WindowCounts
  hour: WindowCounts
  day: WindowCounts
}

/** A weighted percentile of the sampled answer times. */
function percentile(
  samples: Array<{ ms: number; weight: number }>,
  p: number,
): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.ms - b.ms)
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0)
  const target = (p / 100) * total
  let seen = 0

  for (const entry of sorted) {
    seen += entry.weight
    if (seen >= target) return entry.ms
  }

  return sorted.at(-1)!.ms
}

function counts(buckets: Bucket[], from: number): WindowCounts {
  const inside = buckets.filter((bucket) => bucket.at >= from)
  const samples = inside.flatMap((bucket) =>
    bucket.ms.map((ms) => ({ ms, weight: bucket.weight })),
  )

  return {
    calls: inside.reduce((sum, bucket) => sum + bucket.calls, 0),
    errors: inside.reduce((sum, bucket) => sum + bucket.errors, 0),
    throttles: inside.reduce((sum, bucket) => sum + bucket.throttles, 0),
    bytes: inside.reduce((sum, bucket) => sum + bucket.bytes, 0),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
  }
}

/** The place's state and counters now. */
export function placeView(key: string): PlaceView {
  const state = peek(key)
  const now = gateNow()

  if (state) {
    tidy(state, now)
  }

  const buckets = state?.buckets ?? []
  // This minute and the one before, so it is never a few seconds' worth.
  const minuteStart = now - (now % COUNTER_BUCKET_MS) - COUNTER_BUCKET_MS
  // Whole buckets: the last hour is the merged hours' edge.
  const hourStart = now - COUNTER_HOUR_MS

  return {
    running: state?.active ?? 0,
    waiting: state?.waiting.length ?? 0,
    cooling: coolingAt(key),
    slowing: slowingAt(key),
    since: state?.since ?? now,
    minute: counts(buckets, minuteStart),
    hour: counts(buckets, hourStart),
    day: counts(buckets, now - COUNTER_DAY_MS),
  }
}

/** Ends a place's cool-down, slowdown and hold now (the owner's button). */
export function endCooling(key: string): void {
  const state = peek(key)

  if (state) {
    state.cooling = null
    state.slowdown = null
    state.holdUntil = 0
    state.level = -1
    state.timeouts = 0
    for (const times of state.tools.values()) times.slow = 0
  }
}
