import type { PermissionTier } from "./constants"
import type { VaultContext } from "./context"
import { randomSecret } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import { createCredentialGrant, unlockWithCredential } from "./keys"
import { parsePermissionTiers, storePermissionTiers } from "./permission-rules"

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
  /** May read and change the API endpoints it set up (update_endpoint). */
  manageEndpoints: boolean
  /** May keep memories (the gateway's memory tool). */
  keepMemories: boolean
  /** How PCP may ask the owner about its calls, in trying order. */
  permissionTiers: PermissionTier[]
  servers: Array<{ id: string; name: string }>
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
  /** Requests from this token still waiting for the owner's answer. */
  openPermissions: number
}

export type TokenInput = {
  name: string
  allowAllServers: boolean
  serverIds?: string[]
  /** Left alone on an update when undefined. */
  manageEndpoints?: boolean
  /** Left alone on an update when undefined. */
  keepMemories?: boolean
  /**
   * Which of app, form and url PCP may use to ask; the link is implied.
   * All three on create when undefined; left alone on an update.
   */
  permissionTiers?: string[]
  expiresAt?: Date | null
}

export type ResolvedToken = {
  ctx: VaultContext
  tokenId: string
  tokenName: string
  /** null: every server in the vault. */
  serverIds: string[] | null
  /** May read and change the endpoints it set up (get_endpoint, update_endpoint). */
  manageEndpoints: boolean
  /** May keep memories: its own, and the shared ones (memory). */
  keepMemories: boolean
  /** How PCP may ask the owner about its calls, in trying order. */
  permissionTiers: PermissionTier[]
}

function summaryInclude(now: Date) {
  return {
    servers: { include: { server: { select: { id: true, name: true } } } },
    _count: {
      select: {
        permissionRequests: {
          where: { status: "pending", expiresAt: { gt: now } },
        },
      },
    },
  } as const
}

type SummaryRow = {
  id: string
  name: string
  prefix: string
  allowAllServers: boolean
  manageEndpoints: boolean
  keepMemories: boolean
  permissionTiers: string
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
  servers: Array<{ server: { id: string; name: string } }>
  _count: { permissionRequests: number }
}

function toSummary(row: SummaryRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    allowAllServers: row.allowAllServers,
    manageEndpoints: row.manageEndpoints,
    keepMemories: row.keepMemories,
    permissionTiers: parsePermissionTiers(row.permissionTiers),
    servers: row.servers.map((link) => link.server),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    openPermissions: row._count.permissionRequests,
  }
}

export async function listApiTokens(
  ctx: VaultContext,
): Promise<ApiTokenSummary[]> {
  const rows = await db().apiToken.findMany({
    where: { vaultId: ctx.vaultId },
    include: summaryInclude(new Date()),
    orderBy: { createdAt: "desc" },
  })

  return rows.map(toSummary)
}

export async function getApiToken(
  ctx: VaultContext,
  id: string,
): Promise<ApiTokenSummary> {
  const row = await db().apiToken.findFirst({
    where: { id, vaultId: ctx.vaultId },
    include: summaryInclude(new Date()),
  })

  if (!row) {
    throw notFound("That token")
  }

  return toSummary(row)
}

/** The token row, when it belongs to this vault. */
export async function requireToken(ctx: VaultContext, id: string) {
  const token = await db().apiToken.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!token) {
    throw notFound("That token")
  }

  return token
}

/** A revoked token keeps its row as history; nothing about it changes. */
export async function requireLiveToken(ctx: VaultContext, id: string) {
  const token = await requireToken(ctx, id)

  if (token.revokedAt) {
    throw new PcpError("state", "A revoked token cannot be changed.")
  }

  return token
}

/** Checks a token's name, servers and expiry; returns them cleaned up. */
async function validateTokenInput(
  ctx: VaultContext,
  input: TokenInput,
): Promise<{
  name: string
  serverIds: string[]
  /** The stored form, or undefined to keep (or default) it. */
  permissionTiers: string | undefined
}> {
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

  const permissionTiers =
    input.permissionTiers === undefined
      ? undefined
      : storePermissionTiers(input.permissionTiers)

  return { name, serverIds, permissionTiers }
}

export async function createApiToken(
  ctx: VaultContext,
  input: TokenInput,
): Promise<{ id: string; token: string }> {
  const { name, serverIds, permissionTiers } = await validateTokenInput(
    ctx,
    input,
  )

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
      keepMemories: input.keepMemories ?? false,
      ...(permissionTiers !== undefined ? { permissionTiers } : {}),
      expiresAt: input.expiresAt ?? null,
      servers: { create: serverIds.map((serverId) => ({ serverId })) },
    },
  })

  return { id, token }
}

/**
 * Changes a token after the fact: its name, the servers it reaches, how
 * PCP asks the owner about its calls, and its expiry (each optional field
 * is left alone when undefined). The token itself, and the key it unwraps,
 * stay the same.
 */
export async function updateApiToken(
  ctx: VaultContext,
  id: string,
  input: TokenInput,
): Promise<void> {
  await requireLiveToken(ctx, id)
  const { name, serverIds, permissionTiers } = await validateTokenInput(
    ctx,
    input,
  )

  await db().$transaction([
    db().apiToken.update({
      where: { id },
      data: {
        name,
        allowAllServers: input.allowAllServers,
        ...(input.manageEndpoints !== undefined
          ? { manageEndpoints: input.manageEndpoints }
          : {}),
        ...(input.keepMemories !== undefined
          ? { keepMemories: input.keepMemories }
          : {}),
        ...(permissionTiers !== undefined ? { permissionTiers } : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt }
          : {}),
      },
    }),
    db().apiTokenServer.deleteMany({ where: { tokenId: id } }),
    ...(serverIds.length > 0
      ? [
          db().apiTokenServer.createMany({
            data: serverIds.map((serverId) => ({ tokenId: id, serverId })),
          }),
        ]
      : []),
  ])
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
    keepMemories: record.keepMemories,
    permissionTiers: parsePermissionTiers(record.permissionTiers),
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
