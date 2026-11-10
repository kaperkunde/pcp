import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { stopCleanup, cleanupIdle } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { keyedHash } from "../keyed-hash"
import {
  getSetting,
  getVaultSetting,
  setSetting,
  SETTING_PUBLIC_URL,
} from "../settings"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { ensureSealed, forgetSealedVaults } from "./convert"

// The owner's descriptive values are sealed at rest (#96): what each table
// stores, that every reader takes the old plain form too, and that a vault
// from before is sealed by the requests that follow.

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetSealedVaults()
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await stopCleanup()
  await cleanupIdle()
  forgetSealedVaults()
  await cleanup()
})

/** Whether the text is anywhere in the database's files. */
async function onDisk(text: string): Promise<boolean> {
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
  return readFileSync(databaseFile()).includes(Buffer.from(text, "utf8"))
}

describe("keyedHash", () => {
  it("depends on the key, the label and the text", () => {
    const other = Buffer.alloc(32, 7)
    const hash = keyedHash(ctx.dek, "a", "x")

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(keyedHash(ctx.dek, "a", "x")).toBe(hash)
    expect(keyedHash(ctx.dek, "b", "x")).not.toBe(hash)
    expect(keyedHash(ctx.dek, "a", "y")).not.toBe(hash)
    expect(keyedHash(other, "a", "x")).not.toBe(hash)
  })
})

describe("settings", () => {
  it("seals a vault's setting and keeps the public address plain", async () => {
    await setSetting(ctx, "pacing", '{"marker":"SETTING-MARKER-1"}')
    await setSetting(ctx, SETTING_PUBLIC_URL, "https://pcp.example")

    expect(await getSetting(ctx, "pacing")).toBe(
      '{"marker":"SETTING-MARKER-1"}',
    )
    expect(await onDisk("SETTING-MARKER-1")).toBe(false)
    expect(await getVaultSetting(ctx.vaultId, SETTING_PUBLIC_URL)).toBe(
      "https://pcp.example",
    )
    await expect(getVaultSetting(ctx.vaultId, "pacing")).rejects.toThrow()
  })

  it("reads one from before as it was, and seals it on a request", async () => {
    await db().setting.create({
      data: { vaultId: ctx.vaultId, key: "toolTiers", value: '{"a":"read"}' },
    })

    expect(await getSetting(ctx, "toolTiers")).toBe('{"a":"read"}')
    expect(await ensureSealed(ctx)).toBe(true)

    const row = await db().setting.findFirstOrThrow({
      where: { key: "toolTiers" },
    })
    expect(row.value).toMatch(/^pcp-sealed:v1:/)
    expect(await getSetting(ctx, "toolTiers")).toBe('{"a":"read"}')
  })
})
