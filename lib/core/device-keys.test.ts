import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "./api-tokens"
import { db } from "./db"
import {
  createDeviceKey,
  deviceKeyInfo,
  removeDeviceKeys,
  unlockWithDeviceKey,
  verifyDeviceKey,
} from "./device-keys"
import { scratchDatabase } from "./test-db"
import {
  changePassword,
  resetPasswordWithRecoveryKey,
  setupVault,
} from "./vault"

// The Touch ID key against a scratch database: it opens the vault like the
// password, there is one at a time, and the ways the owner takes back
// control (recovery, signing out everywhere) remove it.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"

describe("the Touch ID key", () => {
  it("unlocks the vault it was made for, and confirms it is the owner", async () => {
    const { vaultId, dek } = await setupVault({
      name: "Ada",
      password: PASSWORD,
    })
    const ctx = { vaultId, dek }
    expect(await deviceKeyInfo(vaultId)).toBeNull()

    const key = await createDeviceKey(ctx)
    expect(key).toMatch(/^pcp_device_[A-Za-z0-9_-]{43}$/)

    const unlocked = await unlockWithDeviceKey(key)
    expect(unlocked?.vaultId).toBe(vaultId)
    expect(unlocked?.dek.equals(dek)).toBe(true)
    await expect(verifyDeviceKey(ctx, key)).resolves.toBeUndefined()

    // The database holds only a hash of it.
    const grant = await db().keyGrant.findFirstOrThrow({
      where: { kind: "device" },
    })
    expect(key).not.toContain(grant.lookupHash ?? "x")
    expect(await deviceKeyInfo(vaultId)).toMatchObject({
      createdAt: grant.createdAt,
    })
  })

  it("is the only key of its kind: a new one replaces the old", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const first = await createDeviceKey(ctx)
    const second = await createDeviceKey(ctx)

    expect(await unlockWithDeviceKey(first)).toBeNull()
    expect((await unlockWithDeviceKey(second))?.vaultId).toBe(ctx.vaultId)
    expect(await db().keyGrant.count({ where: { kind: "device" } })).toBe(1)
  })

  it("accepts nothing else in its place", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const key = await createDeviceKey(ctx)
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })

    for (const wrong of [
      "",
      PASSWORD,
      ctx.recoveryKey,
      token,
      key.slice(0, -1),
      `pcp_device_${"A".repeat(43)}`,
    ]) {
      expect(await unlockWithDeviceKey(wrong)).toBeNull()
      await expect(verifyDeviceKey(ctx, wrong)).rejects.toThrow(
        /no longer set up/,
      )
    }

    // Another vault's key does not confirm this one's owner.
    await expect(
      verifyDeviceKey({ ...ctx, vaultId: "another-vault" }, key),
    ).rejects.toThrow(/no longer set up/)
  })

  it("survives a password change, and is gone after a recovery or turning it off", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const key = await createDeviceKey(ctx)

    await changePassword(ctx, PASSWORD, "another long password")
    expect(await unlockWithDeviceKey(key)).not.toBeNull()

    await resetPasswordWithRecoveryKey(ctx.recoveryKey, "third long password")
    expect(await unlockWithDeviceKey(key)).toBeNull()
    expect(await deviceKeyInfo(ctx.vaultId)).toBeNull()

    const again = await createDeviceKey(ctx)
    await removeDeviceKeys(ctx.vaultId)
    expect(await unlockWithDeviceKey(again)).toBeNull()
  })
})
