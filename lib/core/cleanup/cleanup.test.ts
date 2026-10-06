import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { logDir } from "../data-dir"
import { db } from "../db"
import { getHostJson, setHostJson } from "../host-settings"
import { pruneOAuthStates } from "../oauth"
import {
  approveAuthorization,
  checkAuthorizationRequest,
} from "../oauth-server/authorize"
import { registerClient } from "../oauth-server/clients"
import { scratchDatabase } from "../test-db"
import { keepResult, RESULT_TTL_MS } from "../tool-results"
import { setupVault } from "../vault"
import { DEFAULT_CLEANUP_CRON, DEFAULT_LOG_DAYS } from "./limits"
import { runCleanup } from "./run"
import {
  cleanUp,
  cleanupIdle,
  cleanupOverview,
  cleanupSchedule,
  reconcileCleanup,
  startCleanup,
  stopCleanup,
} from "./runtime"
import {
  checkCron,
  checkLogDays,
  CLEANUP_CONFIG_KEY,
  describeRemoved,
  getCleanupConfig,
  getCleanupStatus,
  saveCleanupConfig,
} from "./state"

vi.mock("../oauth", async (importOriginal) => {
  const original = await importOriginal<typeof import("../oauth")>()
  return { ...original, pruneOAuthStates: vi.fn(original.pruneOAuthStates) }
})

// The cleanup: what the owner may set, what one run removes, and the
// node-cron task that follows the owner's schedule.

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  }))
})

afterEach(async () => {
  await stopCleanup()
  await cleanupIdle()
  await cleanup()
})

function logDay(day: string): void {
  mkdirSync(logDir(), { recursive: true })
  writeFileSync(path.join(logDir(), `mcp-${day}.jsonl`), "{}\n")
}

describe("the schedule", () => {
  const now = new Date("2026-10-06T10:00:00Z")

  it("takes five fields that run at least once a day", () => {
    expect(checkCron("*/15 * * * *", now)).toBe("*/15 * * * *")
    expect(checkCron("  7   3 * * * ", now)).toBe("7 3 * * *")
    expect(checkCron("0 */12 * * *", now)).toBe("0 */12 * * *")
  })

  it("refuses seconds, nonsense, and a schedule that skips a day", () => {
    expect(() => checkCron("* * * * * *", now)).toThrow(/five fields/)
    expect(() => checkCron("@daily", now)).toThrow(/five fields/)
    expect(() => checkCron("61 * * * *", now)).toThrow(/does not work/)
    expect(() => checkCron("0 0 30 2 *", now)).toThrow(/does not work/)
    expect(() => checkCron("0 3 * * 1-5", now)).toThrow(/more than a day/)
    expect(() => checkCron("0 3 1 * *", now)).toThrow(/more than a day/)
    expect(() => checkCron("", now)).toThrow(/Enter a schedule/)
  })

  it("keeps the log for 1 to 3650 days", () => {
    expect(checkLogDays(1)).toBe(1)
    expect(() => checkLogDays(0)).toThrow()
    expect(() => checkLogDays(1.5)).toThrow()
    expect(() => checkLogDays(3651)).toThrow()
  })

  it("has defaults, and falls back to them for what it cannot read", async () => {
    expect(await getCleanupConfig()).toEqual({
      cron: DEFAULT_CLEANUP_CRON,
      logDays: DEFAULT_LOG_DAYS,
    })

    await setHostJson(CLEANUP_CONFIG_KEY, { cron: "* * * * * *", logDays: -1 })
    expect(await getCleanupConfig()).toEqual({
      cron: DEFAULT_CLEANUP_CRON,
      logDays: DEFAULT_LOG_DAYS,
    })

    await saveCleanupConfig({ cron: "*/15 * * * *", logDays: 7 })
    expect(await getCleanupConfig()).toEqual({
      cron: "*/15 * * * *",
      logDays: 7,
    })
  })

  it("saves nothing it would refuse to read", async () => {
    await expect(
      saveCleanupConfig({ cron: "0 3 * * 1", logDays: 7 }),
    ).rejects.toThrow(/more than a day/)
    expect(await getHostJson(CLEANUP_CONFIG_KEY)).toBeNull()
  })
})

describe("a run", () => {
  it("removes kept results past their day and the days of log not kept, and says so", async () => {
    const now = new Date()
    const made = new Date(now.getTime() - RESULT_TTL_MS - 60_000)
    const old = {
      tokenId,
      serverId: null,
      toolName: "t",
      mediaType: "text/plain",
    }
    // Keeping one removes the token's own expired ones, so the fresh first.
    await keepResult(ctx, { ...old, text: "fresh" }, now)
    await keepResult(ctx, { ...old, text: "stale" }, made)
    await saveCleanupConfig({ cron: DEFAULT_CLEANUP_CRON, logDays: 2 })

    const today = now.toISOString().slice(0, 10)
    logDay("2020-01-01")
    logDay("2020-01-02")
    logDay(today)

    const status = await runCleanup("owner", now)

    expect(status.removed).toMatchObject({ results: 1, logDays: 2 })
    expect(status.problems).toBeUndefined()
    expect(await db().toolResult.count()).toBe(1)
    expect(readdirSync(logDir())).toEqual([`mcp-${today}.jsonl`])
    expect(await getCleanupStatus()).toMatchObject({
      trigger: "owner",
      lastRunAt: now.toISOString(),
      removed: { results: 1, logDays: 2 },
    })
    expect(describeRemoved(status.removed!)).toBe(
      "1 kept result past its day and 2 days of log",
    )
  })

  it("removes apps' expired codes and tokens with their keys, and registrations never used", async () => {
    const redirect = "https://assistant.example/callback"
    const used = await registerClient({
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    })
    await registerClient({
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    })
    const check = await checkAuthorizationRequest(
      {
        response_type: "code",
        client_id: used.client_id,
        redirect_uri: redirect,
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      },
      "https://pcp.example",
    )
    if (check.kind !== "ok") throw new Error(check.kind)
    await approveAuthorization(
      ctx,
      check.request,
      { token: { name: "App", allowAllServers: true } },
      "https://pcp.example",
    )
    expect(await db().keyGrant.count({ where: { kind: "oauth_code" } })).toBe(1)

    // A day on: the code is long expired, the unused registration too old.
    const status = await runCleanup(
      "owner",
      new Date(Date.now() + 25 * 60 * 60 * 1000),
    )

    expect(status.removed?.apps).toBe(2)
    expect(await db().keyGrant.count({ where: { kind: "oauth_code" } })).toBe(0)
    expect(await db().oAuthCredential.count()).toBe(0)
    expect((await db().oAuthClient.findMany()).map((row) => row.id)).toEqual([
      used.client_id,
    ])
    expect(describeRemoved(status.removed!)).toContain("2 expired app sign-ins")
  })

  it("runs every part when one fails, and names the one that did", async () => {
    vi.mocked(pruneOAuthStates).mockRejectedValueOnce(new Error("disk"))
    logDay("2020-01-01")
    vi.spyOn(console, "error").mockImplementationOnce(() => {})

    const status = await runCleanup("schedule")

    expect(status.problems).toEqual([
      "Could not remove unfinished server sign-ins.",
    ])
    expect(status.removed?.logDays).toBe(1)
  })
})

describe("the task", () => {
  it("runs once at start, then follows the owner's schedule", async () => {
    logDay("2020-01-01")
    await startCleanup()

    expect(cleanupSchedule()).toBe(DEFAULT_CLEANUP_CRON)
    expect(await getCleanupStatus()).toMatchObject({
      trigger: "start",
      removed: { logDays: 1 },
    })

    await saveCleanupConfig({ cron: "*/15 * * * *", logDays: 30 })
    await reconcileCleanup()
    expect(cleanupSchedule()).toBe("*/15 * * * *")

    const overview = await cleanupOverview()
    expect(overview).toMatchObject({
      cron: "*/15 * * * *",
      scheduleId: "quarter-hour",
      logDays: 30,
      lastRemoved: "1 day of log",
    })
    expect(Date.parse(overview.nextRunAt!) - Date.now()).toBeLessThanOrEqual(
      15 * 60_000,
    )
  })

  it("runs one at a time, whoever asks", async () => {
    const [first, second] = await Promise.all([
      cleanUp("owner"),
      cleanUp("schedule"),
    ])

    expect(Date.parse(second.lastRunAt!)).toBeGreaterThanOrEqual(
      Date.parse(first.lastRunAt!),
    )
    expect((await getCleanupStatus()).trigger).toBe("schedule")
  })

  it("has no task once stopped", async () => {
    await startCleanup()
    await stopCleanup()
    expect(cleanupSchedule()).toBeNull()
    expect((await cleanupOverview()).nextRunAt).toBeNull()
  })
})
