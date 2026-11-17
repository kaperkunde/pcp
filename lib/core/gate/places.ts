import {
  sharedBackoff,
  type Cooling,
  type Effect,
  type Place,
  type Signal,
  type Slowing,
  type WindowCounts as LibraryCounts,
} from "@kaperkunde/backoff"

import type { Throttle } from "../throttle-signal"
import {
  BASELINE_MIN,
  BASELINE_SAMPLES,
  GATE_BOUNDS,
  GATE_DEFAULTS,
  LEARNED_TIMEOUT_FACTOR,
  LINGER_MS,
  MAX_GATED_PLACES,
  MAX_TOOLS_TRACKED,
  SLOW_DETECTION,
  SLOW_FACTOR,
  SLOW_FLOOR_MS,
  SLOW_RUN,
  SLOWDOWN_OPTIONS,
  type GateClass,
  type GateLimits,
} from "./limits"

/**
 * The gate's places (#143): one per vault and server, or vault and site,
 * each a `Place` of @kaperkunde/backoff, which keeps its calls running and
 * waiting, its cool-down (cockatiel's circuit breaker: only a refusal opens
 * it), its slowdown, its usual times and its counters, in this process's
 * memory. Like pacing's, nothing is shared between replicas or kept over a
 * restart: a cool-down a restart forgets is found again by the place's next
 * refusal, and the counters say since when they count. PCP's own rules ride
 * on top: the classes' defaults and bounds, the owner's limits, and what a
 * place's signal is (throttle-signal.ts).
 */

export type { Cooling, Effect, Slowing }

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

const places = () => sharedBackoff("pcp.gate", { maxPlaces: MAX_GATED_PLACES })

export function serverPlace(vaultId: string, serverId: string): string {
  return `${vaultId}\nserver:${serverId}`
}

export function sitePlace(vaultId: string, host: string): string {
  return `${vaultId}\nsite:${host}`
}

/**
 * The place for a key, made or updated with these limits. With `learn`
 * (a server whose time limit the owner did not set), each tool's time limit
 * is learned from its answers (RFC 6298, the package's `learnTimeout`): only
 * ever raised over its class's, to LEARNED_TIMEOUT_FACTOR times it at most,
 * so a tool that always takes long but answers is given that time.
 */
export function placeAt(
  key: string,
  label: string,
  gateClass: GateClass,
  limits: GateLimits,
  { learn = false }: { learn?: boolean } = {},
): Place {
  return places().place(key, {
    label,
    limits,
    learnTimeout: learn
      ? {
          floorMs: limits.timeoutMs,
          ceilingMs: Math.min(
            GATE_BOUNDS.timeoutMs.max,
            limits.timeoutMs * LEARNED_TIMEOUT_FACTOR,
          ),
        }
      : undefined,
    detect: SLOW_DETECTION[gateClass],
    lingerMs: LINGER_MS,
    slowdown: SLOWDOWN_OPTIONS,
    latency: {
      slowFactor: SLOW_FACTOR,
      slowFloorMs: SLOW_FLOOR_MS,
      slowRun: SLOW_RUN,
      baselineSamples: BASELINE_SAMPLES,
      baselineMin: BASELINE_MIN,
      maxTools: MAX_TOOLS_TRACKED,
    },
  })
}

/** A site's place, the browser's and web fetch's alike. */
export function sitePlaceAt(
  key: string,
  host: string,
  gateClass: "browser_site" | "web_fetch_site",
): Place {
  return placeAt(key, host, gateClass, GATE_DEFAULTS[gateClass])
}

/** The place for a key if there is one, without making it. */
export function peekPlace(key: string): Place | undefined {
  return places().peek(key)
}

/** A place's cool-down now, or null. */
export function coolingAt(key: string): Cooling | null {
  return peekPlace(key)?.cooling() ?? null
}

/** How much slower a place's calls go now, or null. */
export function slowingAt(key: string): Slowing | null {
  return peekPlace(key)?.slowing() ?? null
}

/** Ends a place's cool-down, slowdown and hold now (the owner's button). */
export function endCooling(key: string): void {
  peekPlace(key)?.reset()
}

/** Tests: forget every place. */
export function resetGate(): void {
  places().clear()
}

/** Tests: how many places are held. */
export function placeCount(): number {
  return places().size
}

function counts(window: LibraryCounts): WindowCounts {
  return {
    calls: window.calls,
    errors: window.errors,
    throttles: window.signals,
    bytes: window.bytes,
    p50Ms: window.p50Ms,
    p95Ms: window.p95Ms,
  }
}

/** A place's state and counters now. */
export function placeView(key: string): PlaceView {
  const place = peekPlace(key)

  if (!place) {
    const none = {
      calls: 0,
      errors: 0,
      throttles: 0,
      bytes: 0,
      p50Ms: null,
      p95Ms: null,
    }
    return {
      running: 0,
      waiting: 0,
      cooling: null,
      slowing: null,
      since: Date.now(),
      minute: none,
      hour: none,
      day: none,
    }
  }

  const view = place.view()

  return {
    running: view.running,
    waiting: view.waiting,
    cooling: view.cooling,
    slowing: view.slowing,
    since: view.since,
    minute: counts(view.minute),
    hour: counts(view.hour),
    day: counts(view.day),
  }
}

/**
 * A place's own "slow down" as the library's signal: a hold waits for a
 * reset, `slow` goes slower, anything else is a refusal.
 */
export function signalOfThrottle(throttle: Throttle | null): Signal | null {
  if (!throttle) {
    return null
  }

  if (throttle.hold) {
    return {
      kind: "hold",
      reason: throttle.reason,
      retryAfterMs: throttle.retryAfterMs ?? 0,
    }
  }

  if (throttle.slow) {
    return { kind: "slow", reason: throttle.reason }
  }

  return {
    kind: "refuse",
    reason: throttle.reason,
    ...(throttle.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: throttle.retryAfterMs }),
  }
}
