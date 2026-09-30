import type { VaultContext } from "./context"
import { randomSecret, safeEqual, sha256Hex } from "./crypto"
import { db } from "./db"
import { newId } from "./ids"
import { createCredentialGrant, unlockWithCredential } from "./keys"

/**
 * Browser sessions. The cookie carries a random secret that wraps the data
 * key (a `session` grant); the database keeps only its hash. Restarting the
 * server does not sign anyone out, and the server still cannot read a vault
 * without a request that presents the cookie.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

export type ResolvedSession = {
  ctx: VaultContext
  sessionId: string
  expiresAt: Date
}

export async function createSession(
  ctx: VaultContext,
  { userAgent }: { userAgent?: string | null } = {},
): Promise<{ cookieValue: string; expiresAt: Date }> {
  const secret = randomSecret()
  const grant = await createCredentialGrant(
    ctx.vaultId,
    ctx.dek,
    "session",
    secret,
  )
  const id = newId()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await db().session.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      grantId: grant.id,
      expiresAt,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
  })

  return { cookieValue: `${id}.${secret}`, expiresAt }
}

export async function resolveSession(
  cookieValue: string | undefined | null,
): Promise<ResolvedSession | null> {
  if (!cookieValue) {
    return null
  }

  const dot = cookieValue.indexOf(".")

  if (dot <= 0) {
    return null
  }

  const id = cookieValue.slice(0, dot)
  const secret = cookieValue.slice(dot + 1)
  const session = await db().session.findUnique({
    where: { id },
    include: { grant: true },
  })

  if (!session) {
    return null
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await destroySession(id)
    return null
  }

  if (
    !session.grant.lookupHash ||
    !safeEqual(session.grant.lookupHash, sha256Hex(secret))
  ) {
    return null
  }

  const unlocked = await unlockWithCredential("session", secret)

  if (!unlocked || unlocked.grant.id !== session.grantId) {
    return null
  }

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    void db()
      .session.update({ where: { id }, data: { lastSeenAt: new Date() } })
      .catch(() => {})
  }

  return {
    ctx: { vaultId: session.vaultId, dek: unlocked.dek },
    sessionId: id,
    expiresAt: session.expiresAt,
  }
}

export async function destroySession(sessionId: string): Promise<void> {
  const session = await db().session.findUnique({ where: { id: sessionId } })

  if (!session) {
    return
  }

  // The grant row owns the wrapped key; deleting it cascades to the session.
  await db().keyGrant.delete({ where: { id: session.grantId } })
}

export async function destroyAllSessions(vaultId: string): Promise<void> {
  await db().keyGrant.deleteMany({ where: { vaultId, kind: "session" } })
}

export async function pruneExpiredSessions(): Promise<number> {
  const expired = await db().session.findMany({
    where: { expiresAt: { lte: new Date() } },
    select: { grantId: true },
  })

  if (expired.length === 0) {
    return 0
  }

  const result = await db().keyGrant.deleteMany({
    where: { id: { in: expired.map((row) => row.grantId) } },
  })

  return result.count
}
