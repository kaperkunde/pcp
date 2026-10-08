import { revokeAllApiTokens } from "./api-tokens"
import { MIN_PASSWORD_LENGTH } from "./constants"
import type { VaultContext } from "./context"
import { generateDek, randomSecret } from "./crypto"
import { db } from "./db"
import { removeDeviceKeys } from "./device-keys"
import { invalid, PcpError } from "./errors"
import { newId } from "./ids"
import {
  credentialGrantData,
  passwordGrantData,
  replacePasswordGrant,
  replaceRecoveryGrant,
  unlockWithCredential,
  unlockWithPassword,
} from "./keys"
import { destroyAllSessions } from "./sessions"
import { SETTING_PUBLIC_URL, setSetting } from "./settings"

/**
 * The vault: one per person. The single-user product has exactly one, made
 * on the setup page; everything else keys off its id.
 */

const RECOVERY_PREFIX = "pcp_recovery_"

/**
 * Whether setup has happened, once a check has found the vault. On
 * globalThis because instrumentation.ts and the Server Actions are bundled
 * apart: deleting the vault (lib/core/vault-reset.ts) must reach the copy
 * the update check reads too.
 */
const SET_UP = Symbol.for("pcp.setUp")

function setUpHolder(): { [SET_UP]?: boolean } {
  return globalThis as unknown as { [SET_UP]?: boolean }
}

/**
 * Whether setup has happened. Once true it stays true until the owner
 * deletes the vault, so after the first check this is free.
 */
export async function isSetUp(): Promise<boolean> {
  const holder = setUpHolder()

  if (holder[SET_UP]) {
    return true
  }

  const count = await db().vault.count()
  holder[SET_UP] = count > 0

  return holder[SET_UP]
}

/** Forgets the cached answer: after the vault is deleted, and in tests. */
export function forgetSetupState(): void {
  setUpHolder()[SET_UP] = false
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }

  if (password.length > 1024) {
    return "That password is too long."
  }

  return null
}

/**
 * Creates the vault, its data key, the password grant and a recovery key.
 * The recovery key is returned once and never stored: it is the only way
 * back in without the password.
 */
export async function setupVault({
  name,
  password,
}: {
  name: string
  password: string
}): Promise<{ vaultId: string; dek: Buffer; recoveryKey: string }> {
  const trimmed = name.trim()

  if (!trimmed) {
    throw invalid("Enter a name.")
  }

  if (trimmed.length > 80) {
    throw invalid("Keep the name under 80 characters.")
  }

  const passwordProblem = validatePassword(password)

  if (passwordProblem) {
    throw invalid(passwordProblem)
  }

  if (await isSetUp()) {
    throw new PcpError("state", "PCP is already set up.")
  }

  const vaultId = newId()
  const dek = generateDek()
  const recoveryKey = `${RECOVERY_PREFIX}${randomSecret()}`
  const passwordGrant = await passwordGrantData(vaultId, dek, password)
  const recoveryGrant = await credentialGrantData(
    vaultId,
    dek,
    "recovery",
    recoveryKey,
  )

  // One transaction: a vault is never left without a way in, and a second
  // setup racing this one sees the vault and stops (SQLite serialises
  // writers).
  await db().$transaction(async (tx) => {
    if ((await tx.vault.count()) > 0) {
      throw new PcpError("state", "PCP is already set up.")
    }

    await tx.vault.create({ data: { id: vaultId, name: trimmed } })
    await tx.keyGrant.create({ data: passwordGrant })
    await tx.keyGrant.create({ data: recoveryGrant })
  })

  setUpHolder()[SET_UP] = true

  return { vaultId, dek, recoveryKey }
}

/** The owner's vault, for the single-user login page. */
export async function ownerVault() {
  return db().vault.findFirst({ orderBy: { createdAt: "asc" } })
}

export async function getVault(vaultId: string) {
  return db().vault.findUniqueOrThrow({ where: { id: vaultId } })
}

/** Signs the owner in: the vault context, or null for a wrong password. */
export async function unlockOwnerVault(
  password: string,
): Promise<VaultContext | null> {
  const vault = await ownerVault()

  if (!vault) {
    return null
  }

  const dek = await unlockWithPassword(vault.id, password)

  return dek ? { vaultId: vault.id, dek } : null
}

/**
 * Throws unless `password` is the vault's password. For asking for it again
 * inside a session, before something that would outlast the session.
 */
export async function verifyPassword(
  ctx: VaultContext,
  password: string,
): Promise<void> {
  const dek = password ? await unlockWithPassword(ctx.vaultId, password) : null

  if (!dek) {
    throw new PcpError("unauthorized", "That password is not right.")
  }
}

export async function changePassword(
  ctx: VaultContext,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const passwordProblem = validatePassword(newPassword)

  if (passwordProblem) {
    throw invalid(passwordProblem)
  }

  const dek = await unlockWithPassword(ctx.vaultId, currentPassword)

  if (!dek) {
    throw new PcpError("unauthorized", "The current password is wrong.")
  }

  await replacePasswordGrant(ctx.vaultId, dek, newPassword)
}

/**
 * Ends every session, turns Touch ID off and forgets the pinned public
 * address. API tokens hold their own copy of the key and keep working,
 * unless `revokeApiTokens` is set: the choice for someone who thinks another
 * person has had their password or a token.
 *
 * The public address goes too because it decides where permission links,
 * the MCP address on token pages and PCP's sign-in metadata point: one
 * pinned from a stolen session would send the next sign-in elsewhere long
 * after that session is gone. PCP goes back to the address each request
 * comes in on until the owner pins it again.
 */
export async function signOutEverywhere(
  ctx: VaultContext,
  { revokeApiTokens = false }: { revokeApiTokens?: boolean } = {},
): Promise<void> {
  if (revokeApiTokens) {
    await revokeAllApiTokens(ctx)
  }

  await setSetting(ctx, SETTING_PUBLIC_URL, null)
  // Touch ID signs in, so it goes with the sessions.
  await removeDeviceKeys(ctx.vaultId)
  await destroyAllSessions(ctx.vaultId)
}

/**
 * Sets a new password from the recovery key, then signs out everywhere
 * (signOutEverywhere): every session, Touch ID and the pinned public
 * address, and every API token too when `revokeApiTokens` is set.
 */
export async function resetPasswordWithRecoveryKey(
  recoveryKey: string,
  newPassword: string,
  { revokeApiTokens = false }: { revokeApiTokens?: boolean } = {},
): Promise<VaultContext> {
  const passwordProblem = validatePassword(newPassword)

  if (passwordProblem) {
    throw invalid(passwordProblem)
  }

  const key = recoveryKey.trim()
  const unlocked = key.startsWith(RECOVERY_PREFIX)
    ? await unlockWithCredential("recovery", key)
    : null

  if (!unlocked) {
    throw new PcpError("unauthorized", "That recovery key is not right.")
  }

  const { grant, dek } = unlocked
  const ctx = { vaultId: grant.vaultId, dek }
  await replacePasswordGrant(grant.vaultId, dek, newPassword)
  await signOutEverywhere(ctx, { revokeApiTokens })

  return ctx
}

/** A fresh recovery key; the previous one stops working. */
export async function rotateRecoveryKey(ctx: VaultContext): Promise<string> {
  const recoveryKey = `${RECOVERY_PREFIX}${randomSecret()}`
  await replaceRecoveryGrant(ctx.vaultId, ctx.dek, recoveryKey)

  return recoveryKey
}
