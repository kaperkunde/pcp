import type { CallToolResult } from "@modelcontextprotocol/server"

import type { VaultContext } from "../context"
import { paceServerCall, pacedResult, type PacedRefusal } from "../pacing"
import { pacingOff } from "../pacing/limits"
import { waitBudget } from "../pacing/pace"
import { familyError } from "../tools/family"
import { effectiveLimits, showBytes, showDuration } from "./config"
import {
  gateClassOf,
  GATE_DEFAULTS,
  LINGER_MS,
  SLOW_DETECTION,
  type GateLimits,
} from "./limits"
import { stripThrottle, throttleOf, type Throttle } from "../throttle-signal"
import {
  acquire,
  bytesFreeIn,
  bytesToday,
  coolingAt,
  gateNow,
  holdAt,
  placeView,
  recordEnd,
  recordLateThrottle,
  release,
  serverPlace,
  sitePlace,
  usualMs,
  type CallEnd,
  type Cooling,
  type PlaceView,
} from "./state"
import { readServerLimits } from "./store"

/**
 * The call gate (#143): one way every call to a place is let through, so a
 * place that is slow or asks PCP to slow down is treated the same whatever
 * its kind and whatever way the call came. Applied where pacing is, and
 * only there: upstream.ts callServerTool for a server's tools (every kind
 * but the browser and a wrapper; execute_<tier>, run_<tier>'s pcp.call,
 * wrappers and flows, the owner's answers, capabilities), the browser per
 * site (browser/call.ts) and web fetch per site (web-fetch.ts runFetch).
 *
 * A call to a server, in order:
 * 1. Cooling down (the server asked PCP to slow down, or answered far
 *    slower than usual): refused at once, `paced` with retryAfterMs.
 * 2. Its bytes for the day spent: refused the same way.
 * 3. Its pace (pacing's, with the server's own pause and calls a minute as
 *    a floor): waits its turn within its own time, or `paced`.
 * 4. Calls at once: waits for a turn within what is left, or `paced`.
 * 5. Runs within its time limit: past it, a `timeout` tool error naming
 *    the server and the limit. Its turn is kept until it really ends (at
 *    most LINGER_MS more), so a slow place is not sent more at once.
 * 6. Counted, and read for throttling (signals.ts; state.ts recordEnd).
 *
 * The limits are the server's own where it has them (store.ts), its
 * class's defaults otherwise (limits.ts); the owner sets them, an
 * assistant only proposes. None of it is in search or a tool's
 * description: an assistant hears of a limit when a call cannot go, and
 * reads them with get_server_limits.
 */

export { gateClassOf, type GateClass, type GateLimits } from "./limits"
export type { Cooling, PlaceView } from "./state"

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

/** What a call is told while its place cools down. */
export function coolingRefusal(label: string, cooling: Cooling): PacedRefusal {
  const retryAfterMs = Math.max(0, cooling.until - gateNow())

  return {
    message: `${label} is cooling down: ${cooling.reason}. Nothing was sent; try again in ${seconds(retryAfterMs)} s.`,
    retryAfterMs,
  }
}

/** The bytes an answer brings, where they can be counted. */
export function resultBytes(result: CallToolResult): number {
  let bytes = 0

  for (const block of result.content ?? []) {
    if (block.type === "text") {
      bytes += Buffer.byteLength(block.text)
    } else if ("data" in block && typeof block.data === "string") {
      bytes += Math.floor((block.data.length * 3) / 4)
    } else if (block.type === "resource") {
      const resource = block.resource as { text?: unknown; blob?: unknown }
      if (typeof resource.text === "string") {
        bytes += Buffer.byteLength(resource.text)
      } else if (typeof resource.blob === "string") {
        bytes += Math.floor((resource.blob.length * 3) / 4)
      }
    }
  }

  if (bytes === 0 && result.structuredContent !== undefined) {
    bytes = Buffer.byteLength(JSON.stringify(result.structuredContent))
  }

  return bytes
}

/** What the first throttled call adds to its own answer. */
function coolingNote(label: string, cooling: Cooling): string {
  return `PCP lets ${label} cool down for ${seconds(cooling.until - cooling.since)} s: ${cooling.reason}.`
}

type GatedServer = { id: string; name: string; kind: string }

/** A server's limits now: its own over its class's defaults. */
export async function serverLimits(
  ctx: VaultContext,
  server: { id: string; kind: string },
): Promise<GateLimits | null> {
  const gateClass = gateClassOf(server.kind)

  return gateClass
    ? effectiveLimits(gateClass, await readServerLimits(ctx, server.id))
    : null
}

/**
 * A call to one of a server's tools, through the gate. `run` makes the
 * call, given the server's own time limit when the owner set one (a kind
 * that can stop itself at it does; without one each kind keeps its own
 * default); the answer is its own, or a `paced` or `timeout` tool error,
 * at the limit in force either way.
 */
export async function gateServerCall(
  ctx: VaultContext,
  server: GatedServer,
  toolName: string,
  { signal, deadline }: { signal?: AbortSignal; deadline?: number } = {},
  run: (timeoutMs: number | undefined) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const gateClass = gateClassOf(server.kind)

  if (!gateClass) {
    return run(undefined)
  }

  const own = await readServerLimits(ctx, server.id)
  const limits = effectiveLimits(gateClass, own)

  const key = serverPlace(ctx.vaultId, server.id)
  const label = server.name
  const cooling = coolingAt(key)

  if (cooling) {
    return pacedResult(coolingRefusal(label, cooling))
  }

  if (limits.bytesPerDay !== null) {
    const bytes = bytesToday(key)

    if (bytes >= limits.bytesPerDay) {
      const retryAfterMs = bytesFreeIn(key, limits.bytesPerDay)
      return pacedResult({
        message: `${label} has answered ${showBytes(bytes)} today, its limit for a day (${showBytes(limits.bytesPerDay)}). Nothing was sent; try again in ${seconds(retryAfterMs)} s.`,
        retryAfterMs,
      })
    }
  }

  const asked = gateNow()
  // A rate limit with nothing left: wait for its reset, within this call's
  // own time, or say when.
  const hold = holdAt(key)

  if (hold) {
    const wait = hold - asked
    const room = pacingOff()
      ? Math.max(waitBudget(deadline, asked), 30_000)
      : waitBudget(deadline, asked)

    if (wait > room) {
      return pacedResult({
        message: `${label}'s rate limit has no calls left until it resets. Nothing was sent; try again in ${seconds(wait)} s.`,
        retryAfterMs: wait,
      })
    }

    await sleep(wait, signal)
  }

  const paced = await paceServerCall(ctx, server, toolName, {
    signal,
    deadline,
    floor: {
      minIntervalMs: limits.minIntervalMs,
      callsPerMinute: limits.callsPerMinute,
    },
  })

  if (paced) {
    return pacedResult(paced)
  }

  const budget = Math.max(
    0,
    waitBudget(deadline, gateNow()) - (gateNow() - asked),
  )
  // Pacing off (test suites) waits for nothing but the turns themselves.
  const turned = await acquire(
    key,
    label,
    limits.maxConcurrent,
    pacingOff() ? Math.max(budget, 30_000) : budget,
    signal,
  )

  // A cool-down that started while this one waited its turn: refused now.
  const since = turned ? coolingAt(key) : null

  if (since) {
    release(key)
    return pacedResult(coolingRefusal(label, since))
  }

  if (!turned) {
    const retryAfterMs = usualMs(key, toolName)
    return pacedResult({
      message: `${label} is already answering ${limits.maxConcurrent} call${limits.maxConcurrent === 1 ? "" : "s"}, as many as it takes at once, for longer than this call can wait. Nothing was sent; try again in ${seconds(retryAfterMs)} s.`,
      retryAfterMs,
    })
  }

  return runTimed(
    key,
    label,
    limits,
    { tool: toolName, detect: SLOW_DETECTION[gateClassOf(server.kind)!] },
    () => run(own.timeoutMs),
  )
}

/** Waits `ms`, or rejects with the signal's reason when it aborts. */
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

/**
 * Runs a call that holds a turn at the place: within its time limit,
 * counted, read for throttling, the turn given back when it ends.
 */
async function runTimed(
  key: string,
  label: string,
  limits: GateLimits,
  how: Pick<CallEnd, "tool" | "detect">,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = gateNow()
  const call = run()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), limits.timeoutMs)
  })

  let outcome: { result: CallToolResult } | { error: unknown } | "late"

  try {
    outcome = await Promise.race([
      call.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
      late,
    ])
  } finally {
    clearTimeout(timer)
  }

  if (outcome === "late") {
    recordEnd(key, label, limits, {
      ...how,
      ok: false,
      ms: limits.timeoutMs,
      timedOut: true,
    })
    // The turn stays taken until the call really ends, or LINGER_MS on.
    let given = false
    const giveBack = () => {
      if (!given) {
        given = true
        release(key)
      }
    }
    const linger = setTimeout(giveBack, LINGER_MS)
    linger.unref?.()
    void call
      .then(
        (result) => throttleOf(result),
        (error: unknown) => throttleOf(error),
      )
      .then((throttle) => {
        if (throttle) {
          recordLateThrottle(key, label, limits, throttle)
        }
      })
      .catch(() => {})
      .finally(() => {
        giveBack()
        clearTimeout(linger)
      })

    return familyError(
      `${label} did not answer within ${showDuration(limits.timeoutMs)}, its time limit for a call, so PCP stopped waiting. What it was asked may still happen there; check before you call it again.`,
      "timeout",
    )
  }

  release(key)
  const ms = gateNow() - started

  if ("error" in outcome) {
    const throttle = throttleOf(outcome.error)
    const cooled = recordEnd(key, label, limits, {
      ...how,
      ok: false,
      ms,
      throttle,
    })

    // Said on the error itself, which keeps its class (a PcpError's code,
    // a public-only refusal) for whoever handles it.
    if (cooled && throttle && outcome.error instanceof Error) {
      outcome.error.message = `${outcome.error.message} ${coolingNote(label, cooled)}`
    }

    throw outcome.error
  }

  const result = outcome.result
  const throttle: Throttle | null = throttleOf(result)
  stripThrottle(result)
  const cooled = recordEnd(key, label, limits, {
    ...how,
    ok: result.isError !== true,
    ms,
    bytes: resultBytes(result),
    throttle,
  })

  return cooled && throttle
    ? {
        ...result,
        content: [
          ...(result.content ?? []),
          { type: "text", text: coolingNote(label, cooled) },
        ],
      }
    : result
}

/** A site's place: the browser's and web fetch's, the same per host. */
export function siteKey(ctx: VaultContext, host: string): string {
  return sitePlace(ctx.vaultId, host)
}

/**
 * Before a request to a site (web fetch, a browser action): refused while
 * the site cools down.
 */
export function siteCooling(
  ctx: VaultContext,
  host: string,
): PacedRefusal | null {
  const cooling = coolingAt(sitePlace(ctx.vaultId, host))
  return cooling ? coolingRefusal(host, cooling) : null
}

/**
 * After a request to a site: counted, and read for the site's own request
 * to slow down (429, Retry-After); a slow page alone is not one.
 */
export function recordSite(
  ctx: VaultContext,
  host: string,
  gateClass: "browser_site" | "web_fetch_site",
  end: {
    ok: boolean
    ms: number
    bytes?: number
    throttle?: Throttle | null
  },
): Cooling | null {
  return recordEnd(
    sitePlace(ctx.vaultId, host),
    host,
    GATE_DEFAULTS[gateClass],
    { ...end, detect: SLOW_DETECTION[gateClass] },
  )
}

/** A server's gate now: cooling down, running, waiting and its counters. */
export function serverGateView(ctx: VaultContext, serverId: string): PlaceView {
  return placeView(serverPlace(ctx.vaultId, serverId))
}

/** A server's cool-down now, as check_server tells it; null when none. */
export function serverCooling(
  ctx: VaultContext,
  serverId: string,
): {
  reason: string
  since: string
  until: string
  retryAfterMs: number
} | null {
  const cooling = coolingAt(serverPlace(ctx.vaultId, serverId))

  return cooling
    ? {
        reason: cooling.reason,
        since: new Date(cooling.since).toISOString(),
        until: new Date(cooling.until).toISOString(),
        retryAfterMs: Math.max(0, cooling.until - gateNow()),
      }
    : null
}

export { endCooling, serverPlace } from "./state"
