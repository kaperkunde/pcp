import type { KeyGrant } from "@/lib/generated/prisma/client"

import {
  asBytes,
  CryptoError,
  deriveKek,
  newHkdfParams,
  newScryptParams,
  parseKdfParams,
  sha256Hex,
  unwrapDek,
  wrapDek,
} from "./crypto"
import { db } from "./db"
import { newId } from "./ids"

/**
 * Key grants: each row is the vault's data key wrapped under one
 * credential. See lib/core/crypto.ts for the model.
 */

export type GrantKind = "password" | "recovery" | "session" | "api_token"

type GrantData = {
  id: string
  vaultId: string
  kind: GrantKind
  lookupHash?: string
  kdf: "scrypt" | "hkdf"
  kdfParams: string
  wrappedDek: Uint8Array<ArrayBuffer>
}

/**
 * A password grant, ready to insert. The slow key derivation happens here,
 * outside any transaction, so it never holds the database's write lock.
 */
export async function passwordGrantData(
  vaultId: string,
  dek: Buffer,
  password: string,
): Promise<GrantData> {
  const id = newId()
  const params = newScryptParams()
  const kek = await deriveKek(password, params)

  return {
    id,
    vaultId,
    kind: "password",
    kdf: "scrypt",
    kdfParams: JSON.stringify(params),
    wrappedDek: asBytes(wrapDek(dek, kek, id)),
  }
}

/** A grant for a random credential, ready to insert. */
export async function credentialGrantData(
  vaultId: string,
  dek: Buffer,
  kind: Exclude<GrantKind, "password">,
  credential: string,
): Promise<GrantData> {
  const id = newId()
  const params = newHkdfParams()
  const kek = await deriveKek(credential, params)

  return {
    id,
    vaultId,
    kind,
    lookupHash: sha256Hex(credential),
    kdf: "hkdf",
    kdfParams: JSON.stringify(params),
    wrappedDek: asBytes(wrapDek(dek, kek, id)),
  }
}

/** The data key, or null when the password is wrong. */
export async function unlockWithPassword(
  vaultId: string,
  password: string,
): Promise<Buffer | null> {
  const grant = await db().keyGrant.findFirst({
    where: { vaultId, kind: "password" },
    orderBy: { createdAt: "desc" },
  })

  if (!grant) {
    return null
  }

  return unwrapGrant(grant, password)
}

/**
 * A grant for a random, high-entropy credential (a session secret, an API
 * token, the recovery key). Found again by the SHA-256 of the credential.
 */
export async function createCredentialGrant(
  vaultId: string,
  dek: Buffer,
  kind: Exclude<GrantKind, "password">,
  credential: string,
): Promise<KeyGrant> {
  return db().keyGrant.create({
    data: await credentialGrantData(vaultId, dek, kind, credential),
  })
}

export async function unlockWithCredential(
  kind: Exclude<GrantKind, "password">,
  credential: string,
): Promise<{ grant: KeyGrant; dek: Buffer } | null> {
  const grant = await db().keyGrant.findUnique({
    where: { lookupHash: sha256Hex(credential) },
  })

  if (!grant || grant.kind !== kind) {
    return null
  }

  const dek = await unwrapGrant(grant, credential)

  return dek ? { grant, dek } : null
}

/** Replaces the vault's password grant. Other grants keep working. */
export async function replacePasswordGrant(
  vaultId: string,
  dek: Buffer,
  newPassword: string,
): Promise<void> {
  const data = await passwordGrantData(vaultId, dek, newPassword)

  await db().$transaction([
    db().keyGrant.deleteMany({ where: { vaultId, kind: "password" } }),
    db().keyGrant.create({ data }),
  ])
}

/** Replaces the vault's recovery grant, so exactly one key works. */
export async function replaceRecoveryGrant(
  vaultId: string,
  dek: Buffer,
  recoveryKey: string,
): Promise<void> {
  const data = await credentialGrantData(vaultId, dek, "recovery", recoveryKey)

  await db().$transaction([
    db().keyGrant.deleteMany({ where: { vaultId, kind: "recovery" } }),
    db().keyGrant.create({ data }),
  ])
}

async function unwrapGrant(
  grant: KeyGrant,
  credential: string,
): Promise<Buffer | null> {
  try {
    const kek = await deriveKek(credential, parseKdfParams(grant.kdfParams))
    const dek = unwrapDek(Buffer.from(grant.wrappedDek), kek, grant.id)

    // Fire and forget: the timestamp is informational.
    void db()
      .keyGrant.update({
        where: { id: grant.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {})

    return dek
  } catch (error) {
    if (error instanceof CryptoError) {
      return null
    }

    throw error
  }
}
