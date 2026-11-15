import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import { pacedRetryAfter } from "../pacing"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { errorCodeOf } from "../tools/outcome"
import { setupVault } from "../vault"
import {
  applyLimitsChange,
  checkLimits,
  effectiveLimits,
  limitsChangeLines,
  limitsChangeOf,
  LIMITS_ARG,
} from "./config"
import {
  gateServerCall,
  recordSite,
  serverCooling,
  serverGateView,
  siteCooling,
} from "./index"
import { GATE_DEFAULTS } from "./limits"
import { httpThrottle, throttleOf, withThrottle } from "./signals"
import {
  acquire,
  placeView,
  recordEnd,
  release,
  resetGate,
  setGateClock,
} from "./state"
import { readServerLimits, writeServerLimits } from "./store"

const headers = (values: Record<string, string>) => new Headers(values)
const NOW = Date.parse("2026-11-15T12:00:00Z")

describe("a place asking PCP to slow down", () => {
  it("is a 429, with its Retry-After in seconds or as a date", () => {
    expect(httpThrottle(429, headers({ "retry-after": "30" }), NOW)).toEqual({
      reason: "it answered HTTP 429 (too many requests)",
      retryAfterMs: 30_000,
    })
    expect(
      httpThrottle(
        429,
        headers({ "retry-after": "Sun, 15 Nov 2026 12:02:00 GMT" }),
        NOW,
      ),
    ).toMatchObject({ retryAfterMs: 120_000 })
    expect(httpThrottle(429, headers({}), NOW)).toEqual({
      reason: "it answered HTTP 429 (too many requests)",
    })
  })

  it("is a 503 only with a Retry-After, and a rate limit with nothing left", () => {
    expect(httpThrottle(503, headers({}), NOW)).toBeNull()
    expect(httpThrottle(503, headers({ "retry-after": "5" }), NOW)).toEqual({
      reason: "it answered HTTP 503 and asked to be called again later",
      retryAfterMs: 5_000,
    })
    expect(
      httpThrottle(
        200,
        headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" }),
        NOW,
      ),
    ).toEqual({
      reason: "its rate limit has no calls left until it resets",
      retryAfterMs: 60_000,
    })
    // A reset as a Unix time, as some APIs send it.
    expect(
      httpThrottle(
        200,
        headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((NOW + 90_000) / 1000),
        }),
        NOW,
      ),
    ).toMatchObject({ retryAfterMs: 90_000 })
    expect(
      httpThrottle(200, headers({ "ratelimit-remaining": "3" }), NOW),
    ).toBeNull()
  })

  it("is read off an error's causes and off an answer (the contract with mail and calendar code)", () => {
    const inner = Object.assign(new Error("BYE"), {
      pcpThrottle: { reason: "the server said it is busy", retryAfterMs: 1e12 },
    })
    expect(throttleOf(new Error("outer", { cause: inner }))).toEqual({
      reason: "the server said it is busy",
      // Bounded: a day at most.
      retryAfterMs: 24 * 60 * 60_000,
    })
    expect(throttleOf(new Error("plain"))).toBeNull()

    const answer = withThrottle({ content: [] } as CallToolResult, {
      reason: "slow down",
    })
    expect(throttleOf(answer)).toEqual({ reason: "slow down" })
    // Never sent on: it is not one of the answer's own keys.
    expect(JSON.stringify(answer)).toBe('{"content":[]}')
  })
})

describe("limits", () => {
  it("are taken as an assistant writes them, within the machine's bounds", () => {
    const arg = LIMITS_ARG.parse({
      max_concurrent: 1,
      timeout_ms: 30_000,
      calls_per_minute: "none",
      bytes_per_day: "default",
    })
    expect(limitsChangeOf(arg)).toEqual({
      maxConcurrent: 1,
      timeoutMs: 30_000,
      callsPerMinute: null,
      bytesPerDay: "default",
    })
    expect(() => LIMITS_ARG.parse({ max_concurrent: 0 })).toThrow()
    expect(() => LIMITS_ARG.parse({ max_concurrent: "none" })).toThrow()
    expect(() => LIMITS_ARG.parse({ speed: 1 })).toThrow()
  })

  it("are checked whole, and a change unsets what goes back to the default", () => {
    expect(() => checkLimits({ timeoutMs: 10 })).toThrow(/Time limit per call/)
    expect(() => checkLimits({ maxConcurrent: null })).toThrow(/needs a number/)
    expect(() =>
      checkLimits({ backoffBaseMs: 60_000, backoffMaxMs: 30_000 }),
    ).toThrow(/cannot be longer/)
    expect(
      applyLimitsChange(
        { maxConcurrent: 1, timeoutMs: 20_000 },
        { maxConcurrent: "default", callsPerMinute: 10 },
      ),
    ).toEqual({ timeoutMs: 20_000, callsPerMinute: 10 })
  })

  it("follow the class's defaults where none are set, and say what changes", () => {
    expect(effectiveLimits("mail", { maxConcurrent: 1 })).toEqual({
      ...GATE_DEFAULTS.mail,
      maxConcurrent: 1,
    })
    expect(
      limitsChangeLines("mail", { timeoutMs: 20_000 }, { maxConcurrent: 1 }),
    ).toEqual([
      "Calls at once: 2 (PCP's default) → 1",
      "Time limit per call: 20 s → 45 s (PCP's default)",
    ])
  })
})

describe("the gate's state", () => {
  let now = NOW
  const limits = { ...GATE_DEFAULTS.mail, backoffBaseMs: 10_000 }

  beforeEach(() => {
    now = NOW
    resetGate()
    setGateClock({ now: () => now })
  })

  afterEach(() => {
    setGateClock(null)
    resetGate()
  })

  it("cools a place down for as long as it asked, then lets calls through", () => {
    const cooled = recordEnd("k", "Mail", limits, {
      ok: false,
      ms: 200,
      throttle: { reason: "too many logins", retryAfterMs: 60_000 },
    })
    expect(cooled).toEqual({
      reason: "too many logins",
      since: NOW,
      until: NOW + 60_000,
    })
    expect(placeView("k").cooling).not.toBeNull()

    now += 60_001
    expect(placeView("k").cooling).toBeNull()
  })

  it("doubles the cool-down when it is asked again soon after, up to the longest", () => {
    const throttle = { reason: "busy" }
    const lengths: number[] = []

    for (let round = 0; round < 8; round++) {
      const cooled = recordEnd("k", "Mail", limits, {
        ok: false,
        ms: 100,
        throttle,
      })!
      lengths.push(cooled.until - cooled.since)
      now = cooled.until + 1_000
    }

    expect(lengths).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000,
    ])

    // A success at its usual pace ends the run; the next one starts over.
    recordEnd("k", "Mail", limits, { ok: true, ms: 100 })
    const fresh = recordEnd("k", "Mail", limits, {
      ok: false,
      ms: 100,
      throttle,
    })!
    expect(fresh.until - fresh.since).toBe(10_000)
  })

  it("takes a run of answers far slower than usual as a request to slow down", () => {
    for (let i = 0; i < 10; i++) {
      recordEnd("k", "Mail", limits, { ok: true, ms: 400 })
    }

    expect(recordEnd("k", "Mail", limits, { ok: true, ms: 80_000 })).toBeNull()
    expect(recordEnd("k", "Mail", limits, { ok: true, ms: 81_000 })).toBeNull()
    const cooled = recordEnd("k", "Mail", limits, { ok: true, ms: 85_000 })

    expect(cooled?.reason).toBe(
      "its answers are taking much longer than usual (3 in a row, about 85 s each against 1 s)",
    )
    expect(placeView("k").minute.throttles).toBe(1)
  })

  it("takes calls past their time limit in a row as one, with no usual time yet", () => {
    for (let i = 0; i < 2; i++) {
      expect(
        recordEnd("k", "Mail", limits, {
          ok: false,
          ms: 45_000,
          timedOut: true,
        }),
      ).toBeNull()
    }

    expect(
      recordEnd("k", "Mail", limits, { ok: false, ms: 45_000, timedOut: true })
        ?.reason,
    ).toBe("3 calls in a row ran past its time limit")
  })

  it("counts calls, errors, bytes and percentiles over a minute, an hour and a day", () => {
    for (const ms of [100, 200, 300, 400, 1_000]) {
      recordEnd("k", "Mail", limits, { ok: true, ms, bytes: 1_000 })
    }
    now += 30 * 60_000
    recordEnd("k", "Mail", limits, { ok: false, ms: 50 })
    now += 2 * 60 * 60_000
    recordEnd("k", "Mail", limits, { ok: true, ms: 70, bytes: 10 })

    const view = placeView("k")
    expect(view.minute).toMatchObject({ calls: 1, errors: 0, bytes: 10 })
    expect(view.hour).toMatchObject({ calls: 1 })
    expect(view.day).toMatchObject({
      calls: 7,
      errors: 1,
      bytes: 5_010,
      p50Ms: 200,
      p95Ms: 1_000,
    })
  })

  it("lets so many run at once and the next in when one ends", async () => {
    expect(await acquire("k", "Mail", 2, 0)).toBe(true)
    expect(await acquire("k", "Mail", 2, 0)).toBe(true)
    // None free and no time to wait.
    expect(await acquire("k", "Mail", 2, 0)).toBe(false)

    const third = acquire("k", "Mail", 2, 5_000)
    expect(placeView("k")).toMatchObject({ running: 2, waiting: 1 })
    release("k")
    expect(await third).toBe(true)
    expect(placeView("k")).toMatchObject({ running: 2, waiting: 0 })

    // One that waits past its time is not let in later.
    expect(await acquire("k", "Mail", 2, 20)).toBe(false)
    release("k")
    release("k")
    expect(placeView("k").running).toBe(0)
  })
})

describe("a call through the gate", () => {
  let cleanup: () => Promise<void>
  let ctx: VaultContext
  let server: { id: string; name: string; kind: string }

  const answer = (text: string): CallToolResult => ({
    content: [{ type: "text", text }],
  })

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    resetGate()
    ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
    const { id } = await createServer(ctx, {
      name: "Docs",
      url: "https://docs.example/mcp",
      authType: "none",
    })
    server = { id, name: "Docs", kind: "mcp" }
  })

  afterEach(async () => {
    resetGate()
    await cleanup()
  })

  it("keeps a server's own limits sealed, and runs with its time limit", async () => {
    expect(await readServerLimits(ctx, server.id)).toEqual({})
    await writeServerLimits(ctx, server.id, { timeoutMs: 5_000 })
    expect(await readServerLimits(ctx, server.id)).toEqual({ timeoutMs: 5_000 })

    let given = 0
    const result = await gateServerCall(
      ctx,
      server,
      "search",
      {},
      async (ms) => {
        given = ms
        return answer("found")
      },
    )

    expect(result).toEqual(answer("found"))
    expect(given).toBe(5_000)
    expect(serverGateView(ctx, server.id).minute).toMatchObject({ calls: 1 })
  })

  it("answers timeout naming the server and its limit, and keeps the turn until the call ends", async () => {
    await writeServerLimits(ctx, server.id, {
      timeoutMs: 1_000,
      maxConcurrent: 1,
    })
    let finish!: () => void
    const slow = new Promise<CallToolResult>((resolve) => {
      finish = () => resolve(answer("late"))
    })

    const result = await gateServerCall(ctx, server, "search", {}, () => slow)

    expect(errorCodeOf(result)).toBe("timeout")
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "Docs did not answer within 1 s, its time limit for a call",
      ),
    })
    // Still running there: the one turn is taken.
    expect(serverGateView(ctx, server.id).running).toBe(1)
    finish()
    await slow
    await new Promise((resolve) => setImmediate(resolve))
    expect(serverGateView(ctx, server.id).running).toBe(0)
  })

  it("cools a server down on its throttle, refuses calls fast with paced, and says so in its state", async () => {
    const throttled = Object.assign(
      new PcpError("upstream", "Docs could not be reached (HTTP 429)."),
      { pcpThrottle: { reason: "it answered HTTP 429", retryAfterMs: 90_000 } },
    )

    await expect(
      gateServerCall(ctx, server, "search", {}, async () => {
        throw throttled
      }),
    ).rejects.toThrow(
      "Docs could not be reached (HTTP 429). PCP lets Docs cool down for 90 s: it answered HTTP 429.",
    )

    let ran = false
    const refused = await gateServerCall(
      ctx,
      server,
      "search",
      {},
      async () => {
        ran = true
        return answer("no")
      },
    )

    expect(ran).toBe(false)
    expect(errorCodeOf(refused)).toBe("paced")
    expect(pacedRetryAfter(refused)).toBeGreaterThan(89_000)
    expect(refused.content[0]).toMatchObject({
      text: expect.stringMatching(
        /^Docs is cooling down: it answered HTTP 429\. Nothing was sent; try again in 9\d s\.$/,
      ),
    })
    expect(serverCooling(ctx, server.id)).toMatchObject({
      reason: "it answered HTTP 429",
    })
    expect(serverGateView(ctx, server.id).day).toMatchObject({
      calls: 1,
      errors: 1,
      throttles: 1,
    })
  })

  it("refuses past a day's bytes", async () => {
    await writeServerLimits(ctx, server.id, { bytesPerDay: 1_024 })
    await gateServerCall(ctx, server, "read", {}, async () =>
      answer("x".repeat(2_000)),
    )

    const refused = await gateServerCall(ctx, server, "read", {}, async () =>
      answer("never"),
    )
    expect(errorCodeOf(refused)).toBe("paced")
    expect(refused.content[0]).toMatchObject({
      text: expect.stringContaining("its limit for a day (1 KiB)"),
    })
  })

  it("leaves a wrapper alone and counts sites apart", async () => {
    const result = await gateServerCall(
      ctx,
      { id: "w", name: "Flow", kind: "wrapper" },
      "go",
      {},
      async () => answer("ran"),
    )
    expect(result).toEqual(answer("ran"))

    expect(siteCooling(ctx, "shop.example")).toBeNull()
    recordSite(ctx, "shop.example", "web_fetch_site", {
      ok: false,
      ms: 50,
      throttle: { reason: "it answered HTTP 429 (too many requests)" },
    })
    expect(siteCooling(ctx, "shop.example")?.message).toMatch(
      /^shop\.example is cooling down: it answered HTTP 429/,
    )
    // A slow page is not a request to slow down.
    for (let i = 0; i < 10; i++) {
      recordSite(ctx, "slow.example", "web_fetch_site", { ok: true, ms: 10 })
    }
    for (let i = 0; i < 5; i++) {
      recordSite(ctx, "slow.example", "web_fetch_site", {
        ok: true,
        ms: 60_000,
      })
    }
    expect(siteCooling(ctx, "slow.example")).toBeNull()
  })
})
