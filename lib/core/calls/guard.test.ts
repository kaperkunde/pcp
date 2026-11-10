import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { generateDek } from "../crypto"
import { db } from "../db"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  readDuplicateCalls,
  setDuplicateCallWindow,
  guardWindowMs,
} from "./config"
import {
  callHash,
  endCall,
  endOfOutcome,
  guardCall,
  noteBefore,
  pruneCallRecords,
} from "./guard"
import {
  CALL_RECORD_KEEP_MS,
  DUPLICATE_CALL_MS,
  STALE_RUNNING_MS,
} from "./limits"

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string
let serverId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  }))
  ;({ id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  }))
})

afterEach(async () => {
  await cleanup()
})

const target = (
  kind = "mcp",
  tier: "read" | "write" | "destructive" = "write",
) => ({
  server: { id: serverId, slug: "postcards", kind },
  tool: "send",
  tier,
})
const AGAIN = "Pass rerun."

describe("callHash", () => {
  it("is keyed by the vault key, and tells servers, tools and arguments apart", () => {
    const dek = generateDek()
    const base = callHash(dek, "s1", "send", { to: "Ada", text: "hi" })

    expect(callHash(dek, "s1", "send", { text: "hi", to: "Ada" })).toBe(base)
    expect(
      callHash(generateDek(), "s1", "send", { to: "Ada", text: "hi" }),
    ).not.toBe(base)
    expect(callHash(dek, "s2", "send", { to: "Ada", text: "hi" })).not.toBe(
      base,
    )
    expect(callHash(dek, "s1", "post", { to: "Ada", text: "hi" })).not.toBe(
      base,
    )
    expect(callHash(dek, "s1", "send", { to: "Bob", text: "hi" })).not.toBe(
      base,
    )
    expect(base).not.toContain("Ada")
  })
})

describe("guardCall", () => {
  const scope = () => ({ ctx, tokenId })

  it("guards nothing of the Read tier, the browser, SSH or a store", async () => {
    for (const [kind, tier] of [
      ["mcp", "read"],
      ["browser", "destructive"],
      ["ssh", "destructive"],
      ["storage", "destructive"],
    ] as const) {
      for (let i = 0; i < 2; i++) {
        expect(
          await guardCall(scope(), target(kind, tier), {}, { again: AGAIN }),
        ).toEqual({ ticket: null, warning: null })
      }
    }

    expect(await db().callRecord.count()).toBe(0)
  })

  it("holds back the second of two identical calls made at once", async () => {
    const now = new Date()
    const [a, b] = await Promise.all([
      guardCall(scope(), target(), { to: "Ada" }, { again: AGAIN, now }),
      guardCall(scope(), target(), { to: "Ada" }, { again: AGAIN, now }),
    ])

    expect([a, b].filter((result) => "duplicate" in result)).toHaveLength(1)
    expect(await db().callRecord.count()).toBe(1)
  })

  it("forgets a call that came to nothing, and goes by the window", async () => {
    const first = await guardCall(scope(), target(), {}, { again: AGAIN })
    expect("ticket" in first && first.ticket).toBeTruthy()

    // Paced, refused: nothing was sent.
    await endCall(
      "ticket" in first ? first.ticket : null,
      endOfOutcome(
        { ok: false, error: "paced", code: "paced", retryAfterMs: 10 },
        noteBefore(),
      ),
    )
    expect(await db().callRecord.count()).toBe(0)

    const later = new Date(Date.now() + DUPLICATE_CALL_MS + 1_000)
    const made = await guardCall(scope(), target(), {}, { again: AGAIN })
    await endCall("ticket" in made ? made.ticket : null, {
      status: "succeeded",
    })
    expect(
      "ticket" in
        (await guardCall(scope(), target(), {}, { again: AGAIN, now: later })),
    ).toBe(true)
  })

  it("says a call still marked running long after it started may have happened", async () => {
    const started = new Date(Date.now() - STALE_RUNNING_MS - 60_000)
    await guardCall(scope(), target(), {}, { again: AGAIN, now: started })

    const again = await guardCall(scope(), target(), {}, { again: AGAIN })
    expect("duplicate" in again && again.duplicate).toContain(
      "never reported back",
    )
  })

  it("follows the window the owner set for a tool, or none", async () => {
    await setDuplicateCallWindow(ctx, serverId, "send", 5)
    const config = await readDuplicateCalls(ctx.vaultId)
    expect(guardWindowMs(config, serverId, "send")).toBe(5 * 60_000)
    expect(guardWindowMs(config, serverId, "other")).toBe(DUPLICATE_CALL_MS)

    await guardCall(scope(), target(), {}, { again: AGAIN })
    const later = new Date(Date.now() + 6 * 60_000)
    expect(
      "ticket" in
        (await guardCall(scope(), target(), {}, { again: AGAIN, now: later })),
    ).toBe(true)

    await setDuplicateCallWindow(ctx, serverId, "send", "exempt")
    expect(
      guardWindowMs(await readDuplicateCalls(ctx.vaultId), serverId, "send"),
    ).toBeNull()

    await expect(
      setDuplicateCallWindow(ctx, serverId, "send", 0),
    ).rejects.toThrow("Keep the time between")
    await expect(
      setDuplicateCallWindow(ctx, "nope", "send", 5),
    ).rejects.toThrow()

    // Back to PCP's default: nothing kept.
    await setDuplicateCallWindow(ctx, serverId, "send", null)
    expect(await readDuplicateCalls(ctx.vaultId)).toEqual({ tools: {} })
  })
})

describe("pruneCallRecords", () => {
  it("removes records past the longest window", async () => {
    const now = new Date()
    await guardCall(
      { ctx, tokenId },
      target(),
      { a: 1 },
      { again: AGAIN, now: new Date(now.getTime() - CALL_RECORD_KEEP_MS - 1) },
    )
    await guardCall({ ctx, tokenId }, target(), { a: 2 }, { again: AGAIN, now })

    expect(await pruneCallRecords(now)).toBe(1)
    expect(await db().callRecord.count()).toBe(1)
  })
})
