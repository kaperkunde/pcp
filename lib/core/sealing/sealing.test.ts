import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { stopCleanup, cleanupIdle } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { keyedHash } from "../keyed-hash"
import {
  createSecret,
  findOwnerSecretByName,
  listSecrets,
  updateSecret,
} from "../secrets"
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

describe("secrets", () => {
  it("seals the name and description, and finds the secret by name", async () => {
    const { id } = await createSecret(ctx, {
      name: "SECRET-NAME-MARKER",
      description: "SECRET-DESCRIPTION-MARKER",
      value: "v",
    })

    expect(await onDisk("SECRET-NAME-MARKER")).toBe(false)
    expect(await onDisk("SECRET-DESCRIPTION-MARKER")).toBe(false)
    expect(
      await findOwnerSecretByName(ctx, "SECRET-NAME-MARKER"),
    ).toMatchObject({ id, name: "SECRET-NAME-MARKER" })
    expect(await listSecrets(ctx)).toMatchObject([
      {
        id,
        name: "SECRET-NAME-MARKER",
        description: "SECRET-DESCRIPTION-MARKER",
      },
    ])

    const raw = await db().$queryRawUnsafe<
      Array<{ name: string; description: string; name_key: string }>
    >(`SELECT "name", "description", "name_key" FROM "secret"`)
    expect(raw).toEqual([
      {
        name: "",
        description: "",
        name_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])
  })

  it("still refuses a second secret by the same name", async () => {
    await createSecret(ctx, { name: "Mail", value: "a" })
    const { id } = await createSecret(ctx, { name: "Shop", value: "b" })

    await expect(
      createSecret(ctx, { name: "Mail", value: "c" }),
    ).rejects.toThrow(/already exists/)
    await expect(updateSecret(ctx, id, { name: "Mail" })).rejects.toThrow(
      /already exists/,
    )
    // The database refuses one too, should a writer skip the check.
    await expect(
      db().secret.update({
        where: { id },
        data: {
          nameKey: (
            await db().secret.findFirstOrThrow({ where: { id: { not: id } } })
          ).nameKey,
        },
      }),
    ).rejects.toThrow()
  })

  it("reads a secret from before, finds it by name, and seals it", async () => {
    const { id } = await createSecret(ctx, { name: "x", value: "v" })
    await db().$executeRawUnsafe(
      `UPDATE "secret" SET "name" = 'Old mail', "description" = 'From before', "meta" = NULL, "name_key" = NULL WHERE "id" = ?`,
      id,
    )

    expect(await findOwnerSecretByName(ctx, "Old mail")).toMatchObject({ id })
    await expect(
      createSecret(ctx, { name: "Old mail", value: "c" }),
    ).rejects.toThrow(/already exists/)

    expect(await ensureSealed(ctx)).toBe(true)

    expect(await onDisk("From before")).toBe(false)
    expect(await findOwnerSecretByName(ctx, "Old mail")).toMatchObject({ id })
    expect(await listSecrets(ctx)).toMatchObject([
      { id, name: "Old mail", description: "From before" },
    ])
  })
})
