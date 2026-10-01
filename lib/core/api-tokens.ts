import type { VaultContext } from "./context"
import { randomSecret } from "./crypto"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import { createCredentialGrant, unlockWithCredential } from "./keys"

/**
 * API tokens: what an MCP client presents to /mcp as a bearer token. Each
 * one wraps its own copy of the data key (an `api_token` grant), so the
 * gateway can decrypt the secrets a call needs — and only while it holds
 * the token. Revoking a token deletes that copy.
 */

export const TOKEN_PREFIX = "pcp_"
const DISPLAY_PREFIX_LENGTH = 12
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

export type ApiTokenSummary = {
  id: string
  name: string
  prefix: string
  allowAllServers: boolean
  /** May register and change API endpoints through the gateway. */
  manageEndpoints: boolean
  servers: Array<{ id: string; name: string }>
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
}

export type ResolvedToken = {
  ctx: VaultContext
  tokenId: string
  tokenName: string
  /** null: every server in the vault. */
  serverIds: string[] | null
  /** May register and change API endpoints (register_endpoint and friends). */
  manageEndpoints: boolean
}

export async function listApiTokens(
  ctx: VaultContext,
): Promise<ApiTokenSummary[]> {
  const rows = await db().apiToken.findMany({
    where: { vaultId: ctx.vaultId },
    include: {
      servers: { include: { server: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  })

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    allowAllServers: row.allowAllServers,
    manageEndpoints: row.manageEndpoints,
    servers: row.servers.map((link) => link.server),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }))
}

export async function createApiToken(
  ctx: VaultContext,
  input: {
    name: string
    allowAllServers: boolean
    serverIds?: string[]
    manageEndpoints?: boolean
    expiresAt?: Date | null
  },
): Promise<{ id: string; token: string }> {
  const name = input.name.trim()

  if (!name) {
    throw invalid("Give the token a name so you can tell it apart later.")
  }

  if (name.length > 80) {
    throw invalid("Keep the token name under 80 characters.")
  }

  const serverIds = input.allowAllServers ? [] : [...new Set(input.serverIds)]

  if (!input.allowAllServers) {
    if (serverIds.length === 0) {
      throw invalid("Pick at least one server, or allow all of them.")
    }

    const known = await db().mcpServer.count({
      where: { vaultId: ctx.vaultId, id: { in: serverIds } },
    })

    if (known !== serverIds.length) {
      throw invalid("One of the chosen servers does not exist.")
    }
  }

  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw invalid("The expiry must be in the future.")
  }

  const token = `${TOKEN_PREFIX}${randomSecret()}`
  const grant = await createCredentialGrant(
    ctx.vaultId,
    ctx.dek,
    "api_token",
    token,
  )
  const id = newId()

  await db().apiToken.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      grantId: grant.id,
      name,
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      allowAllServers: input.allowAllServers,
      manageEndpoints: input.manageEndpoints ?? false,
      expiresAt: input.expiresAt ?? null,
      servers: { create: serverIds.map((serverId) => ({ serverId })) },
    },
  })

  return { id, token }
}

/**
 * The vault behind a bearer token, or null when the token is unknown,
 * revoked or expired. Callers get the data key and the servers the token
 * may reach — nothing about other vaults, which is what lets one endpoint
 * serve many of them.
 */
export async function resolveApiToken(
  token: string,
): Promise<ResolvedToken | null> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null
  }

  const unlocked = await unlockWithCredential("api_token", token)

  if (!unlocked) {
    return null
  }

  const record = await db().apiToken.findUnique({
    where: { grantId: unlocked.grant.id },
    include: { servers: { select: { serverId: true } } },
  })

  if (
    !record ||
    record.revokedAt ||
    (record.expiresAt && record.expiresAt.getTime() <= Date.now())
  ) {
    return null
  }

  if (
    !record.lastUsedAt ||
    Date.now() - record.lastUsedAt.getTime() > TOUCH_INTERVAL_MS
  ) {
    void db()
      .apiToken.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {})
  }

  return {
    ctx: { vaultId: record.vaultId, dek: unlocked.dek },
    tokenId: record.id,
    tokenName: record.name,
    serverIds: record.allowAllServers
      ? null
      : record.servers.map((link) => link.serverId),
    manageEndpoints: record.manageEndpoints,
  }
}

/** Revoking deletes the token's copy of the key; the row stays as history. */
export async function revokeApiToken(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  const record = await db().apiToken.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!record) {
    throw notFound("That token")
  }

  await db().$transaction([
    db().apiToken.update({
      where: { id },
      data: { revokedAt: record.revokedAt ?? new Date() },
    }),
    db().keyGrant.update({
      where: { id: record.grantId },
      data: blankGrant(),
    }),
  ])
}

/**
 * Revokes every token the vault still has, expired ones included, so none
 * keeps a copy of the key. The answer to "someone else may hold a token".
 */
export async function revokeAllApiTokens(ctx: VaultContext): Promise<number> {
  const live = await db().apiToken.findMany({
    where: { vaultId: ctx.vaultId, revokedAt: null },
    select: { id: true, grantId: true },
  })

  if (live.length === 0) {
    return 0
  }

  await db().$transaction([
    db().apiToken.updateMany({
      where: { id: { in: live.map((token) => token.id) } },
      data: { revokedAt: new Date() },
    }),
    db().keyGrant.updateMany({
      where: { id: { in: live.map((token) => token.grantId) } },
      data: blankGrant(),
    }),
  ])

  return live.length
}

/**
 * A revoked token's grant: the wrapped key overwritten with nothing and the
 * lookup hash gone. The row stays because the token row points at it, but
 * it can no longer open anything.
 */
function blankGrant() {
  return {
    lookupHash: null,
    wrappedDek: new Uint8Array(new ArrayBuffer(0)),
  }
}

export async function deleteApiToken(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  const record = await db().apiToken.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!record) {
    throw notFound("That token")
  }

  await db().keyGrant.delete({ where: { id: record.grantId } })
}
