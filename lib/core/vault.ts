import { revokeAllApiTokens } from "./api-tokens"
import { MIN_PASSWORD_LENGTH } from "./constants"
import type { VaultContext } from "./context"
import { generateDek, randomSecret } from "./crypto"
import { db } from "./db"
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

/**
 * The vault: one per person. The single-user product has exactly one, made
 * on the setup page; everything else keys off its id.
 */

const RECOVERY_PREFIX = "pcp_recovery_"

let knownSetUp = false

/**
 * Whether setup has happened. Once true it stays true (there is no way to
 * delete the vault from the UI), so after the first check this is free.
 */
export async function isSetUp(): Promise<boolean> {
  if (knownSetUp) {
    return true
  }

  const count = await db().vault.count()
  knownSetUp = count > 0

  return knownSetUp
}

/** Tests: forget the cached answer after wiping the database. */
export function forgetSetupState(): void {
  knownSetUp = false
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

  knownSetUp = true

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
 * Sets a new password from the recovery key. Every session is signed out.
 * API tokens hold their own copy of the key and keep working, unless
 * `revokeApiTokens` is set: the choice for someone who thinks another
 * person has had their password or a token.
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
  await destroyAllSessions(grant.vaultId)

  if (revokeApiTokens) {
    await revokeAllApiTokens(ctx)
  }

  return ctx
}

/** A fresh recovery key; the previous one stops working. */
export async function rotateRecoveryKey(ctx: VaultContext): Promise<string> {
  const recoveryKey = `${RECOVERY_PREFIX}${randomSecret()}`
  await replaceRecoveryGrant(ctx.vaultId, ctx.dek, recoveryKey)

  return recoveryKey
}
