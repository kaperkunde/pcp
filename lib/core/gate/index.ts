import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Effect, RefusedWhy } from "@kaperkunde/backoff"

import type { VaultContext } from "../context"
import { paceServerCall, pacedResult, type PacedRefusal } from "../pacing"
import { pacingOff } from "../pacing/limits"
import { waitBudget } from "../pacing/pace"
import { familyError } from "../tools/family"
import { effectiveLimits, showBytes, showDuration } from "./config"
import { gateClassOf, slowedLimits, type GateLimits } from "./limits"
import { stripThrottle, throttleOf, type Throttle } from "../throttle-signal"
import {
  coolingAt,
  placeAt,
  placeView,
  serverPlace,
  signalOfThrottle,
  sitePlace,
  sitePlaceAt,
  slowingAt,
  type Cooling,
  type PlaceView,
} from "./places"
import { readServerLimits } from "./store"

/**
 * The call gate (#143): one way every call to a place is let through, so a
 * place that refuses calls, asks to be called more gently or turns slow is
 * treated the same whatever its kind and whatever way the call came.
 * Applied where pacing is, and only there: upstream.ts callServerTool for a
 * server's tools (every kind but the browser and a wrapper; execute_<tier>,
 * run_<tier>'s pcp.call, wrappers and flows, the owner's answers,
 * capabilities), the browser per site (browser/call.ts) and web fetch per
 * site (web-fetch.ts runFetch).
 *
 * The mechanics are @kaperkunde/backoff's (places.ts): calls at once and
 * calls a minute (p-queue), the cool-down (cockatiel's circuit breaker,
 * opened by a refusal only, one probe after it), the slowdown, spacing,
 * holds, bytes a day and the counters. PCP's part is here: its classes'
 * defaults and the owner's limits, what a place's signal is
 * (throttle-signal.ts), pacing's class pause before a call, and what the
 * assistant is told.
 *
 * A call to a server, in order:
 * 1. Cooling down (the server refused a call as too many or too fast):
 *    refused at once, `paced` with retryAfterMs; once it is over, one call
 *    probes it while the others are refused the same way.
 * 2. Its bytes for the day spent: refused the same way.
 * 3. Pacing's pause for its class (a read or a change).
 * 4. A rate limit with nothing left, its calls a minute, its spacing and
 *    calls at once: waits its turn within its own time, or `paced`.
 * 5. Runs within its time limit: past it, a `timeout` tool error naming the
 *    server and the limit. Its turn is kept until it really ends (at most
 *    LINGER_MS more), so a slow place is not sent more at once.
 * 6. Counted, and read for signals. A server that answers but asks PCP to
 *    go slower (an answer marked throttled), or answers far slower than
 *    usual, is never refused for it: its calls go one at a time, further
 *    apart and with a longer time limit, easing off as answers come back
 *    clean.
 *
 * None of it is in search or a tool's description: an assistant hears of a
 * limit when a call cannot go, and reads them with get_server_limits.
 */

export { gateClassOf, type GateClass, type GateLimits } from "./limits"
export type { Cooling, PlaceView, Slowing } from "./places"

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

/** What a call is told while its place cools down. */
export function coolingRefusal(label: string, cooling: Cooling): PacedRefusal {
  const retryAfterMs = Math.max(0, cooling.until - Date.now())

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

/** What the call that started a cool-down or a slowdown adds to its answer. */
function effectNote(label: string, effect: Effect): string {
  if (effect.kind === "cooling") {
    const { cooling } = effect
    return `PCP lets ${label} cool down for ${seconds(cooling.until - cooling.since)} s: ${cooling.reason}.`
  }

  return `PCP sends ${label} one call at a time from now, at least ${showDuration(effect.limits.minIntervalMs)} apart, and waits up to ${showDuration(effect.limits.timeoutMs)} for each: ${effect.slowing.reason}.`
}

/** A refusal the library answered, in PCP's words. */
function refusalOf(
  label: string,
  limits: GateLimits,
  bytesToday: number,
  refused: { why: RefusedWhy; reason: string; retryAfterMs: number },
): PacedRefusal {
  const again = `Nothing was sent; try again in ${seconds(refused.retryAfterMs)} s.`
  const retryAfterMs = refused.retryAfterMs

  switch (refused.why) {
    case "cooling":
      return {
        message: `${label} is cooling down: ${refused.reason}. ${again}`,
        retryAfterMs,
      }
    case "probing":
      return {
        message: `${label} is being checked after a cool-down: one call is finding out whether it takes calls again. ${again}`,
        retryAfterMs,
      }
    case "bytes":
      return {
        message: `${label} has answered ${showBytes(bytesToday)} today, its limit for a day (${showBytes(limits.bytesPerDay ?? 0)}). ${again}`,
        retryAfterMs,
      }
    case "held":
      return {
        message: `${label}'s rate limit has no calls left until it resets. ${again}`,
        retryAfterMs,
      }
    default:
      return {
        message: `${label} ${refused.reason.replace(/^it /, "")}. ${again}`,
        retryAfterMs,
      }
  }
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
 * call, given the server's own time limit when the owner set one (raised
 * while the server goes slower; a kind that can stop itself at it does;
 * without one each kind keeps its own default); the answer is its own, or a
 * `paced` or `timeout` tool error, at the limit in force either way.
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
  const label = server.name
  const place = placeAt(
    serverPlace(ctx.vaultId, server.id),
    label,
    gateClass,
    limits,
    { learn: own.timeoutMs === undefined },
  )

  // Refused at once while it cools down, before pacing's pause.
  const cooling = place.cooling()

  if (cooling) {
    return pacedResult(coolingRefusal(label, cooling))
  }

  const slowing = place.slowing()
  const asked = Date.now()
  const paced = await paceServerCall(ctx, server, toolName, {
    signal,
    deadline,
  })

  if (paced) {
    return pacedResult(paced)
  }

  const budget = Math.max(
    0,
    waitBudget(deadline, Date.now()) - (Date.now() - asked),
  )
  const result = await place.run<CallToolResult>(
    // The owner's own limit, raised while the server goes slower; or a
    // limit learned past the class's, in whole minutes so it seldom changes
    // (a mail account's pooled session is made for its limit). Otherwise,
    // and while it goes slower, each kind keeps its own, so a mail
    // account's session stays as it is.
    ({ timeoutMs }) =>
      run(
        own.timeoutMs !== undefined
          ? Math.max(own.timeoutMs, timeoutMs)
          : !slowing && timeoutMs > limits.timeoutMs
            ? Math.ceil(timeoutMs / 60_000) * 60_000
            : undefined,
      ),
    {
      tool: toolName,
      ...(signal ? { signal } : {}),
      // Pacing off (test suites) waits for nothing but the turns themselves.
      waitMs: pacingOff() ? Math.max(budget, 30_000) : budget,
      classify: (outcome) =>
        signalOfThrottle(
          throttleOf("value" in outcome ? outcome.value : outcome.error),
        ),
      isOk: (answer) => answer.isError !== true,
      bytes: resultBytes,
    },
  )

  switch (result.kind) {
    case "refused":
      return pacedResult(
        refusalOf(label, place.limits(toolName), place.bytesToday(), result),
      )
    case "timeout":
      return familyError(
        `${label} did not answer within ${showDuration(result.timeoutMs)}, its time limit for a call, so PCP stopped waiting. What it was asked may still happen there; check before you call it again.`,
        "timeout",
      )
    case "error": {
      // Said on the error itself, which keeps its class (a PcpError's code,
      // a public-only refusal) for whoever handles it.
      if (result.effect && result.error instanceof Error) {
        result.error.message = `${result.error.message} ${effectNote(label, result.effect)}`
      }
      throw result.error
    }
    case "ok": {
      const answer = stripThrottle(result.value)
      // The answer is kept whatever came of it; the call that started a
      // cool-down or a slowdown says so.
      return result.effect
        ? {
            ...answer,
            content: [
              ...(answer.content ?? []),
              { type: "text", text: effectNote(label, result.effect) },
            ],
          }
        : answer
    }
  }
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
 * to slow down (429, Retry-After); a slow page alone is not one. Answers
 * the cool-down it started, if any.
 */
export async function recordSite(
  ctx: VaultContext,
  host: string,
  gateClass: "browser_site" | "web_fetch_site",
  end: {
    ok: boolean
    ms: number
    bytes?: number
    throttle?: Throttle | null
  },
): Promise<Cooling | null> {
  const effect = await sitePlaceAt(
    sitePlace(ctx.vaultId, host),
    host,
    gateClass,
  ).observe({
    ok: end.ok,
    ms: end.ms,
    ...(end.bytes === undefined ? {} : { bytes: end.bytes }),
    signal: signalOfThrottle(end.throttle ?? null),
  })

  return effect?.kind === "cooling" ? effect.cooling : null
}

/** A server's gate now: cooling down, going slower, running, waiting and its counters. */
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
        retryAfterMs: Math.max(0, cooling.until - Date.now()),
      }
    : null
}

/**
 * How a server's calls go slower now, as check_server and
 * get_server_limits tell it; null when they do not.
 */
export async function serverSlowing(
  ctx: VaultContext,
  server: { id: string; kind: string },
): Promise<{
  reason: string
  since: string
  min_interval_ms: number
  timeout_ms: number
} | null> {
  const slowing = slowingAt(serverPlace(ctx.vaultId, server.id))
  const limits = slowing ? await serverLimits(ctx, server) : null

  if (!slowing || !limits) {
    return null
  }

  const slowed = slowedLimits(limits, slowing.level)

  return {
    reason: slowing.reason,
    since: new Date(slowing.since).toISOString(),
    min_interval_ms: slowed.minIntervalMs,
    timeout_ms: slowed.timeoutMs,
  }
}

export { endCooling, serverPlace } from "./places"
