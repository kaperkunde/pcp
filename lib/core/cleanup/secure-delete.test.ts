import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { getHostSetting } from "../host-settings"
import { openDatabase } from "../migrate"
import { createSecret, deleteSecret } from "../secrets"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { deleteVault } from "../vault-reset"
import { cleanupIdle, scrubFreedPages, stopCleanup } from "./runtime"
import { reclaimSpace, SCRUBBED_KEY } from "./space"

// What the owner deletes leaves no copy in the database's files: every
// connection zeroes deleted rows (secure_delete), and a removal truncates
// the write-ahead log that still holds the pages as they were.

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await stopCleanup()
  await cleanupIdle()
  await cleanup()
})

function onDisk(marker: string): boolean {
  const needle = Buffer.from(marker, "utf8")
  return [databaseFile(), `${databaseFile()}-wal`].some(
    (file) => existsSync(file) && readFileSync(file).includes(needle),
  )
}

async function pragma(name: string): Promise<number> {
  const rows = await db().$queryRawUnsafe<Array<Record<string, unknown>>>(
    `PRAGMA ${name}`,
  )
  return Number(Object.values(rows[0] ?? {})[0])
}

describe("secure_delete", () => {
  it("is on for the client's connection", async () => {
    expect(await pragma("secure_delete")).toBe(1)
  })

  it("is on for the connection migrations run on", () => {
    const sqlite = openDatabase(
      path.join(path.dirname(databaseFile()), "other.db"),
    )

    try {
      expect(sqlite.pragma("secure_delete", { simple: true })).toBe(1)
    } finally {
      sqlite.close()
    }
  })
})

describe("scrubbing what a removal freed", () => {
  // Written as plain text as an older PCP did, so the test holds whatever
  // PCP seals now.
  async function plainSecret(marker: string): Promise<string> {
    const { id } = await createSecret(ctx, { name: "Mail", value: "v" })
    await db().$executeRawUnsafe(
      `UPDATE "secret" SET "description" = ? WHERE "id" = ?`,
      marker,
      id,
    )
    return id
  }

  it("leaves a deleted secret in neither the file nor its log", async () => {
    const marker = "MARKER-7f3c1e-secret-description"
    const id = await plainSecret(marker)
    expect(onDisk(marker)).toBe(true)

    await deleteSecret(ctx, id)
    await scrubFreedPages({ rebuild: false })

    expect(onDisk(marker)).toBe(false)
  })

  it("rebuilds the file after the vault is deleted", async () => {
    const marker = "MARKER-a91d0b-vault-description"
    await plainSecret(marker)

    await deleteVault(ctx)

    expect(onDisk(marker)).toBe(false)
    expect(await pragma("freelist_count")).toBe(0)
  })

  it("rebuilds the file once after an upgrade, then by its thresholds", async () => {
    expect(await getHostSetting(SCRUBBED_KEY)).toBeNull()
    await reclaimSpace()
    expect(await getHostSetting(SCRUBBED_KEY)).not.toBeNull()
    // Nothing much is free now: no rebuild.
    expect(await reclaimSpace()).toBe(0)
  })
})
