import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import { PublicOnlyRefusal } from "../public-only"
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
import { GATE_DEFAULTS, MAX_GATED_PLACES } from "./limits"
import {
  httpSignal,
  httpThrottle,
  throttleOf,
  withThrottle,
} from "../throttle-signal"
import {
  acquire,
  holdAt,
  placeCount,
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
    expect(
      httpThrottle(429, headers({ "retry-after": "30" }), "Docs", NOW),
    ).toEqual({
      reason: "Docs answered HTTP 429: it asks PCP to slow down",
      retryAfterMs: 30_000,
    })
    expect(
      httpThrottle(
        429,
        headers({ "retry-after": "Sun, 15 Nov 2026 12:02:00 GMT" }),
        "Docs",
        NOW,
      ),
    ).toMatchObject({ retryAfterMs: 120_000 })
    expect(httpThrottle(429, headers({}), "Docs", NOW)).toEqual({
      reason: "Docs answered HTTP 429: it asks PCP to slow down",
    })
    // A 429 that says when its rate limit resets, rather than Retry-After.
    expect(
      httpThrottle(429, headers({ "ratelimit-reset": "20" }), "Docs", NOW),
    ).toMatchObject({ retryAfterMs: 20_000 })
  })

  it("is a 503 only with a Retry-After; a rate limit with nothing left only holds the next call", () => {
    expect(httpThrottle(503, headers({}), "Docs", NOW)).toBeNull()
    expect(
      httpThrottle(503, headers({ "retry-after": "5" }), "Docs", NOW),
    ).toMatchObject({ retryAfterMs: 5_000 })

    const spent = headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "60",
    })
    // Not a refusal: the call went through, perhaps on one bucket of many.
    expect(httpThrottle(200, spent, "Docs", NOW)).toBeNull()
    expect(httpSignal(200, spent, "Docs", NOW)).toEqual({
      reason: "its rate limit has no calls left until it resets",
      retryAfterMs: 60_000,
      hold: true,
    })
    // A reset as a Unix time, as some APIs send it.
    expect(
      httpSignal(
        200,
        headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((NOW + 90_000) / 1000),
        }),
        "Docs",
        NOW,
      ),
    ).toMatchObject({ retryAfterMs: 90_000, hold: true })
    expect(
      httpSignal(200, headers({ "ratelimit-remaining": "3" }), "Docs", NOW),
    ).toBeNull()
  })

  it("is read off an error's causes and off an answer (the contract with mail and calendar code)", () => {
    const inner = withThrottle(new Error("BYE"), {
      reason: "the server said it is busy",
      retryAfterMs: 1e12,
    })
    expect(throttleOf(new Error("outer", { cause: inner }))).toEqual({
      reason: "the server said it is busy",
      // Bounded: an hour at most.
      retryAfterMs: 60 * 60_000,
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

  it("takes a run of one tool's answers far slower than its usual as a request to slow down", () => {
    for (let i = 0; i < 10; i++) {
      recordEnd("k", "Mail", limits, {
        ok: true,
        ms: 400,
        tool: "search_emails",
      })
    }

    const slow = (ms: number) =>
      recordEnd("k", "Mail", limits, { ok: true, ms, tool: "search_emails" })

    expect(slow(80_000)).toBeNull()
    expect(slow(81_000)).toBeNull()
    expect(slow(85_000)?.reason).toBe(
      "its answers to search_emails are taking much longer than usual (3 in a row, about 85 s each against 1 s)",
    )
    expect(placeView("k").minute.throttles).toBe(1)
  })

  it("never takes a slow tool for a slow server: fast commands, then long builds", () => {
    const ssh = GATE_DEFAULTS.ssh

    for (const detect of ["latency", "timeouts"] as const) {
      resetGate()

      for (let i = 0; i < 10; i++) {
        recordEnd("s", "Box", ssh, { ok: true, ms: 80, tool: "ls", detect })
      }

      for (let i = 0; i < 3; i++) {
        expect(
          recordEnd("s", "Box", ssh, {
            ok: true,
            ms: 60_000,
            tool: "build",
            detect,
          }),
        ).toBeNull()
      }

      expect(placeView("s").cooling).toBeNull()
    }

    // Where only time limits count, even a tool's own slow run does not.
    resetGate()
    for (let i = 0; i < 10; i++) {
      recordEnd("s", "Box", ssh, {
        ok: true,
        ms: 80,
        tool: "run_command",
        detect: "timeouts",
      })
    }
    for (let i = 0; i < 4; i++) {
      recordEnd("s", "Box", ssh, {
        ok: true,
        ms: 60_000,
        tool: "run_command",
        detect: "timeouts",
      })
    }
    expect(placeView("s").cooling).toBeNull()
  })

  it("follows a server's Retry-After no further than its longest cool-down", () => {
    const cooled = recordEnd("k", "Mail", limits, {
      ok: false,
      ms: 50,
      throttle: { reason: "Busy.", retryAfterMs: 60 * 60_000 },
    })!

    expect(cooled.until - cooled.since).toBe(limits.backoffMaxMs)
    // Its words, without their full stop, go into a sentence of PCP's.
    expect(cooled.reason).toBe("Busy")
  })

  it("holds the next calls until a spent rate limit resets, and cools nothing", () => {
    recordEnd("k", "Mail", limits, {
      ok: true,
      ms: 50,
      throttle: {
        reason: "its rate limit has no calls left until it resets",
        retryAfterMs: 20_000,
        hold: true,
      },
    })

    expect(placeView("k").cooling).toBeNull()
    expect(placeView("k").minute.throttles).toBe(0)
    expect(holdAt("k")).toBe(NOW + 20_000)
    now += 20_001
    expect(holdAt("k")).toBe(0)
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

  it("samples a busy minute's answer times evenly, not its last ones", () => {
    for (let i = 0; i < 900; i++) {
      recordEnd("k", "Mail", limits, { ok: true, ms: 10 })
    }
    for (let i = 0; i < 100; i++) {
      recordEnd("k", "Mail", limits, { ok: true, ms: 1_000 })
    }

    const { minute } = placeView("k")
    expect(minute.calls).toBe(1_000)
    expect(minute.p50Ms).toBe(10)
  })

  it("keeps a day by the hour past the last one, and never drops a place cooling down", () => {
    for (let minute = 0; minute < 6 * 60; minute++) {
      recordEnd("k", "Mail", limits, { ok: true, ms: 100 + minute })
      now += 60_000
    }

    const view = placeView("k")
    expect(view.day.calls).toBe(6 * 60)
    expect(view.hour.calls).toBe(60)
    expect(view.day.p95Ms).toBeGreaterThan(view.day.p50Ms!)

    resetGate()
    recordEnd("cooling", "Mail", limits, {
      ok: false,
      ms: 1,
      throttle: { reason: "busy" },
    })
    for (let i = 0; i < MAX_GATED_PLACES + 10; i++) {
      recordEnd(`p${i}`, "Other", limits, { ok: true, ms: 1 })
    }

    expect(placeCount()).toBe(MAX_GATED_PLACES)
    expect(placeView("cooling").cooling).not.toBeNull()
  })

  it("lets those waiting in when calls at once is raised", async () => {
    expect(await acquire("k", "Mail", 1, 0)).toBe(true)
    const second = acquire("k", "Mail", 1, 5_000)
    expect(placeView("k").waiting).toBe(1)

    // A later call with the owner's new limit of two.
    expect(await acquire("k", "Mail", 2, 0)).toBe(false)
    expect(await second).toBe(true)
    expect(placeView("k")).toMatchObject({ running: 2, waiting: 0 })
    release("k")
    release("k")
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

    let given: number | undefined = 0
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

  it("cools a server down when a call past its time limit comes back throttled", async () => {
    await writeServerLimits(ctx, server.id, { timeoutMs: 1_000 })
    let finish!: () => void
    const slow = new Promise<CallToolResult>((resolve) => {
      finish = () =>
        resolve(
          Object.assign(answer("late"), {
            pcpThrottle: { reason: "it marks its answers [THROTTLED]" },
          }),
        )
    })

    const result = await gateServerCall(ctx, server, "search", {}, () => slow)

    expect(errorCodeOf(result)).toBe("timeout")
    expect(serverCooling(ctx, server.id)).toBeNull()
    finish()
    await slow
    await new Promise((resolve) => setImmediate(resolve))
    expect(serverCooling(ctx, server.id)).toMatchObject({
      reason: "it marks its answers [THROTTLED]",
    })
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

  it("refuses a call that waited its turn once a cool-down began meanwhile", async () => {
    await writeServerLimits(ctx, server.id, { maxConcurrent: 1 })
    let fail!: (error: Error) => void
    const first = gateServerCall(
      ctx,
      server,
      "search",
      {},
      () =>
        new Promise<CallToolResult>((_, reject) => {
          fail = reject
        }),
    )
    let ran = false
    const second = gateServerCall(ctx, server, "search", {}, async () => {
      ran = true
      return answer("no")
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(serverGateView(ctx, server.id).waiting).toBe(1)

    fail(
      withThrottle(new PcpError("upstream", "Busy."), {
        reason: "it is busy",
        retryAfterMs: 30_000,
      }),
    )
    await expect(first).rejects.toThrow("Busy.")

    const refused = await second
    expect(ran).toBe(false)
    expect(errorCodeOf(refused)).toBe("paced")
    expect(serverGateView(ctx, server.id).running).toBe(0)
  })

  it("says the cool-down on the error itself, which keeps its class", async () => {
    const refusal = withThrottle(new PublicOnlyRefusal("Private address."), {
      reason: "it is busy",
    })

    const thrown = await gateServerCall(ctx, server, "search", {}, async () => {
      throw refusal
    }).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(PublicOnlyRefusal)
    expect((thrown as Error).message).toMatch(
      /^Private address\. PCP lets Docs cool down for 30 s: it is busy\.$/,
    )
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
