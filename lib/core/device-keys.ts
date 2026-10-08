import { TOUCH_ID_REJECTED } from "./constants"
import type { VaultContext } from "./context"
import { randomSecret } from "./crypto"
import { db } from "./db"
import { PcpError } from "./errors"
import { credentialGrantData, unlockWithCredential } from "./keys"

/**
 * The Touch ID key: a random credential the Mac app keeps in the macOS
 * keychain and hands to PCP's page only after Touch ID (desktop/touch-id.mjs).
 * It wraps the data key like an API token does, and stands in for the
 * password where the owner only proves it is them: unlocking, a new API
 * token, an export, a restore, deleting the vault.
 *
 * It is made only after the password is typed, a vault has at most one, an
 * export never carries it, and a recovery or signing out everywhere removes
 * it. It never changes the password, never makes a recovery key, and never
 * makes another Touch ID key: those still take the password, so only the
 * password and the recovery key decide who gets in.
 */

export const DEVICE_KEY_PREFIX = "pcp_device_"

/** A new Touch ID key, shown once; the vault's earlier one stops working. */
export async function createDeviceKey(ctx: VaultContext): Promise<string> {
  const key = `${DEVICE_KEY_PREFIX}${randomSecret()}`
  const data = await credentialGrantData(ctx.vaultId, ctx.dek, "device", key)

  await db().$transaction([
    db().keyGrant.deleteMany({
      where: { vaultId: ctx.vaultId, kind: "device" },
    }),
    db().keyGrant.create({ data }),
  ])

  return key
}

/** Signs the owner in with the Touch ID key: the vault, or null. */
export async function unlockWithDeviceKey(
  key: string,
): Promise<VaultContext | null> {
  if (!key.startsWith(DEVICE_KEY_PREFIX)) {
    return null
  }

  const unlocked = await unlockWithCredential("device", key)

  return unlocked
    ? { vaultId: unlocked.grant.vaultId, dek: unlocked.dek }
    : null
}

/**
 * Throws unless `key` is this vault's Touch ID key. For confirming it is the
 * owner inside a session, where the password would otherwise be asked.
 */
export async function verifyDeviceKey(
  ctx: VaultContext,
  key: string,
): Promise<void> {
  const unlocked = await unlockWithDeviceKey(key)

  if (!unlocked || unlocked.vaultId !== ctx.vaultId) {
    throw new PcpError("unauthorized", TOUCH_ID_REJECTED)
  }
}

/** Turns Touch ID off: the key, wherever it is kept, opens nothing. */
export async function removeDeviceKeys(vaultId: string): Promise<void> {
  await db().keyGrant.deleteMany({ where: { vaultId, kind: "device" } })
}

/** When the vault's Touch ID key was made and last used, or null. */
export async function deviceKeyInfo(
  vaultId: string,
): Promise<{ createdAt: Date; lastUsedAt: Date | null } | null> {
  return db().keyGrant.findFirst({
    where: { vaultId, kind: "device" },
    select: { createdAt: true, lastUsedAt: true },
  })
}
