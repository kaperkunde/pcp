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
  serverSlowing,
  siteCooling,
} from "./index"
import { GATE_BOUNDS, GATE_DEFAULTS, slowedLimits } from "./limits"
import {
  httpSignal,
  httpThrottle,
  throttleOf,
  withThrottle,
} from "../throttle-signal"
import { placeAt, resetGate, serverPlace } from "./places"
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

  it("while a place goes slower: one call at a time, further apart at each level, a longer time limit", () => {
    const mail = GATE_DEFAULTS.mail

    expect(slowedLimits(mail, 1)).toEqual({
      ...mail,
      maxConcurrent: 1,
      minIntervalMs: 1_000,
      timeoutMs: 135_000,
    })
    expect(slowedLimits(mail, 2).minIntervalMs).toBe(2_000)
    expect(slowedLimits(mail, 4).minIntervalMs).toBe(8_000)
    // The time limit is the same at every level (a pooled mail session
    // is not opened again at each step), within the machine's bound.
    expect(slowedLimits(mail, 4).timeoutMs).toBe(135_000)
    expect(
      slowedLimits({ ...mail, timeoutMs: GATE_BOUNDS.timeoutMs.max }, 1)
        .timeoutMs,
    ).toBe(GATE_BOUNDS.timeoutMs.max)
    // A spacing of the owner's that is longer stays.
    expect(
      slowedLimits({ ...mail, minIntervalMs: 30_000 }, 1).minIntervalMs,
    ).toBe(30_000)
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

  it.each([
    {
      said: "an answer marked throttled slows it down",
      throttle: { reason: "it marks its answers [THROTTLED]", slow: true },
      cools: false,
    },
    {
      said: "a refusal cools it down",
      throttle: { reason: "too many connections" },
      cools: true,
    },
  ])(
    "reads a call that came back past its time limit: $said",
    async ({ throttle, cools }) => {
      await writeServerLimits(ctx, server.id, { timeoutMs: 1_000 })
      let finish!: () => void
      const slow = new Promise<CallToolResult>((resolve) => {
        finish = () =>
          resolve(Object.assign(answer("late"), { pcpThrottle: throttle }))
      })

      const result = await gateServerCall(ctx, server, "search", {}, () => slow)

      expect(errorCodeOf(result)).toBe("timeout")
      expect(serverCooling(ctx, server.id)).toBeNull()
      finish()
      await slow
      await new Promise((resolve) => setImmediate(resolve))
      expect(await serverSlowing(ctx, server)).toMatchObject({
        reason: throttle.reason,
      })
      expect(serverCooling(ctx, server.id) !== null).toBe(cools)
    },
  )

  it("keeps an answer marked throttled, says so once, and sends the next calls one at a time with a longer limit", async () => {
    await writeServerLimits(ctx, server.id, {
      timeoutMs: 2_000,
      maxConcurrent: 4,
    })
    const throttled = () =>
      Object.assign(answer("found"), {
        pcpThrottle: {
          reason: "The IMAP server marks its answers [THROTTLED]",
          slow: true,
        },
      })

    const first = await gateServerCall(ctx, server, "search", {}, async () =>
      throttled(),
    )

    expect(first.isError).toBeUndefined()
    expect(first.content).toEqual([
      { type: "text", text: "found" },
      {
        type: "text",
        text: "PCP sends Docs one call at a time from now, at least 1 s apart, and waits up to 6 s for each: The IMAP server marks its answers [THROTTLED].",
      },
    ])
    expect(serverCooling(ctx, server.id)).toBeNull()
    expect(await serverSlowing(ctx, server)).toMatchObject({
      reason: "The IMAP server marks its answers [THROTTLED]",
      min_interval_ms: 1_000,
      timeout_ms: 6_000,
    })

    // The next call is let through, with the longer limit, and its answer
    // marked again says nothing more.
    let given: number | undefined
    const next = await gateServerCall(ctx, server, "search", {}, async (ms) => {
      given = ms
      return throttled()
    })

    expect(errorCodeOf(next)).toBeUndefined()
    expect(next.content).toEqual([{ type: "text", text: "found" }])
    expect(given).toBe(6_000)
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

  it("learns a longer time limit for a tool that always takes long, passed on in whole minutes, never over the owner's", async () => {
    const place = placeAt(
      serverPlace(ctx.vaultId, server.id),
      "Docs",
      "mcp",
      GATE_DEFAULTS.mcp,
      { learn: true },
    )
    for (let i = 0; i < 6; i++) {
      await place.observe({ ok: true, ms: 150_000, tool: "report" })
    }

    let given: number | undefined
    const call = (tool: string) =>
      gateServerCall(ctx, server, tool, {}, async (ms) => {
        given = ms
        return answer("ok")
      })

    // Over its class's 2 minutes, in whole minutes, at most three times it.
    await call("report")
    expect(given! % 60_000).toBe(0)
    expect(given).toBeGreaterThan(120_000)
    expect(given).toBeLessThanOrEqual(360_000)
    // Another tool keeps the kind's own.
    await call("ping")
    expect(given).toBeUndefined()
    // A limit the owner set is never learned over.
    await writeServerLimits(ctx, server.id, { timeoutMs: 5_000 })
    await call("report")
    expect(given).toBe(5_000)
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
    await recordSite(ctx, "shop.example", "web_fetch_site", {
      ok: false,
      ms: 50,
      throttle: { reason: "it answered HTTP 429 (too many requests)" },
    })
    expect(siteCooling(ctx, "shop.example")?.message).toMatch(
      /^shop\.example is cooling down: it answered HTTP 429/,
    )
    // A slow page is not a request to slow down.
    for (let i = 0; i < 10; i++) {
      await recordSite(ctx, "slow.example", "web_fetch_site", {
        ok: true,
        ms: 10,
      })
    }
    for (let i = 0; i < 5; i++) {
      await recordSite(ctx, "slow.example", "web_fetch_site", {
        ok: true,
        ms: 60_000,
      })
    }
    expect(siteCooling(ctx, "slow.example")).toBeNull()
  })
})
