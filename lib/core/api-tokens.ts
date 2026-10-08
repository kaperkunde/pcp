import type { Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { newHkdfParams, randomSecret } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import { createCredentialGrant, unlockWithCredential } from "./keys"

/**
 * API tokens: what an MCP client presents to /mcp as a bearer token. Each
 * one wraps its own copy of the data key (an `api_token` grant), so the
 * gateway can decrypt the secrets a call needs — and only while it holds
 * the token. Revoking a token deletes that copy.
 *
 * A token can also be made by an assistant signing in with OAuth
 * (lib/core/oauth-server/): it has no pcp_ value and an empty grant, and the
 * key travels in its OAuth credentials instead, each with a grant of its
 * own. Everything else (levels, memories, the request log) is the token's,
 * as for any other; revoking or deleting it removes those credentials too.
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
  /** May fetch web pages (the gateway's web_fetch tool). */
  webFetch: boolean
  /** May run programs that call its tools (the gateway's run_code tool). */
  runCode: boolean
  /** May propose wrappers (create_wrapper and its kin). */
  manageWrappers: boolean
  servers: Array<{ id: string; name: string }>
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
  /** Requests from this token still waiting for the owner's answer. */
  openPermissions: number
  /** The assistant it was made for by signing in with OAuth, if it was. */
  oauthClient: { id: string; name: string } | null
}

export type TokenInput = {
  name: string
  allowAllServers: boolean
  serverIds?: string[]
  /** Left alone on an update when undefined. */
  manageEndpoints?: boolean
  /** Left alone on an update when undefined. */
  keepMemories?: boolean
  /** Left alone on an update when undefined. */
  webFetch?: boolean
  /** Left alone on an update when undefined. */
  runCode?: boolean
  /** Left alone on an update when undefined. */
  manageWrappers?: boolean
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
  /** May fetch web pages, as its site and method levels say (web_fetch). */
  webFetch: boolean
  /** May run programs whose calls follow its tool levels (run_code). */
  runCode: boolean
  /** May read wrappers and propose new ones and changes (get_wrapper, …). */
  manageWrappers: boolean
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
  webFetch: boolean
  runCode: boolean
  manageWrappers: boolean
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
  oauthClientId: string | null
  oauthClientName: string | null
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
    webFetch: row.webFetch,
    runCode: row.runCode,
    manageWrappers: row.manageWrappers,
    servers: row.servers.map((link) => link.server),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    openPermissions: row._count.permissionRequests,
    oauthClient: row.oauthClientId
      ? { id: row.oauthClientId, name: row.oauthClientName ?? "" }
      : null,
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

/**
 * Whether an update's expiry (`undefined`: left as it is) brings back a
 * token whose expiry has passed. An expired token is refused but keeps its
 * copy of the key, so a new expiry, or none, makes it work again: that is a
 * lasting way into the vault, like a new token, and takes the owner rather
 * than a session (updateApiToken's `ownerConfirmed`).
 */
export function revivesToken(
  token: { expiresAt: Date | null },
  expiresAt: Date | null | undefined,
): boolean {
  return (
    expiresAt !== undefined &&
    token.expiresAt !== null &&
    token.expiresAt.getTime() <= Date.now()
  )
}

export const EXPIRED_TOKEN_NEEDS_OWNER =
  "This token has expired. Confirm it is you to give it a new expiry."

/** Checks a token's name, servers and expiry; returns them cleaned up. */
async function validateTokenInput(
  ctx: VaultContext,
  input: TokenInput,
): Promise<{
  name: string
  serverIds: string[]
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

  return { name, serverIds }
}

export async function createApiToken(
  ctx: VaultContext,
  input: TokenInput,
): Promise<{ id: string; token: string }> {
  const { name, serverIds } = await validateTokenInput(ctx, input)

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
      webFetch: input.webFetch ?? false,
      runCode: input.runCode ?? false,
      manageWrappers: input.manageWrappers ?? false,
      expiresAt: input.expiresAt ?? null,
      servers: { create: serverIds.map((serverId) => ({ serverId })) },
    },
  })

  return { id, token }
}

/**
 * A token for an assistant the owner let sign in with OAuth. It gets no
 * pcp_ value: its grant is empty from the start (as a revoked token's is),
 * and what unwraps the key are the credentials the authorization server
 * issues for it. Called with the owner's key, after they confirmed.
 */
export async function createOAuthApiToken(
  ctx: VaultContext,
  input: TokenInput & { clientId: string; clientName: string },
): Promise<{ id: string }> {
  const { name, serverIds } = await validateTokenInput(ctx, input)
  const grantId = newId()
  const id = newId()

  await db().$transaction([
    db().keyGrant.create({
      data: {
        id: grantId,
        vaultId: ctx.vaultId,
        kind: "api_token",
        kdf: "hkdf",
        kdfParams: JSON.stringify(newHkdfParams()),
        ...blankGrant(),
      },
    }),
    db().apiToken.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        grantId,
        name,
        prefix: "",
        allowAllServers: input.allowAllServers,
        manageEndpoints: input.manageEndpoints ?? false,
        keepMemories: input.keepMemories ?? false,
        webFetch: input.webFetch ?? false,
        runCode: input.runCode ?? false,
        manageWrappers: input.manageWrappers ?? false,
        expiresAt: input.expiresAt ?? null,
        oauthClientId: input.clientId,
        oauthClientName: input.clientName,
        servers: { create: serverIds.map((serverId) => ({ serverId })) },
      },
    }),
  ])

  return { id }
}

/**
 * Changes a token after the fact: its name, the servers it reaches, what
 * else it may do, and its expiry (each optional field
 * is left alone when undefined). The token itself, and the key it unwraps,
 * stay the same. A new expiry for a token that has expired brings it back
 * (revivesToken), and is refused unless the caller has confirmed the owner
 * (`ownerConfirmed`); every other change is the session's to make.
 */
export async function updateApiToken(
  ctx: VaultContext,
  id: string,
  input: TokenInput,
  { ownerConfirmed = false }: { ownerConfirmed?: boolean } = {},
): Promise<void> {
  const token = await requireLiveToken(ctx, id)

  if (!ownerConfirmed && revivesToken(token, input.expiresAt)) {
    throw new PcpError("forbidden", EXPIRED_TOKEN_NEEDS_OWNER)
  }

  const { name, serverIds } = await validateTokenInput(ctx, input)

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
        ...(input.webFetch !== undefined ? { webFetch: input.webFetch } : {}),
        ...(input.runCode !== undefined ? { runCode: input.runCode } : {}),
        ...(input.manageWrappers !== undefined
          ? { manageWrappers: input.manageWrappers }
          : {}),
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

  return liveToken({ grantId: unlocked.grant.id }, unlocked.dek)
}

/**
 * The token a credential opened (an API token's grant, or an OAuth access
 * token's, oauth-server/tokens.ts), with the key it unwrapped: null when
 * the token is revoked or expired.
 */
export async function liveToken(
  where: Prisma.ApiTokenWhereUniqueInput,
  dek: Buffer,
): Promise<ResolvedToken | null> {
  const record = await db().apiToken.findUnique({
    where,
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
    ctx: { vaultId: record.vaultId, dek },
    tokenId: record.id,
    tokenName: record.name,
    serverIds: record.allowAllServers
      ? null
      : record.servers.map((link) => link.serverId),
    manageEndpoints: record.manageEndpoints,
    keepMemories: record.keepMemories,
    webFetch: record.webFetch,
    runCode: record.runCode,
    manageWrappers: record.manageWrappers,
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

  await revokeTokenRecord(record)
}

/**
 * Revokes a token an assistant signed in for, when the assistant itself
 * asks (RFC 7009 revocation of its refresh token): the same as the owner's
 * Revoke.
 */
export async function revokeOAuthApiToken(id: string): Promise<void> {
  const record = await db().apiToken.findUnique({ where: { id } })

  if (record) {
    await revokeTokenRecord(record)
  }
}

async function revokeTokenRecord(record: {
  id: string
  grantId: string
  revokedAt: Date | null
}): Promise<void> {
  await db().$transaction([
    db().apiToken.update({
      where: { id: record.id },
      data: { revokedAt: record.revokedAt ?? new Date() },
    }),
    db().keyGrant.update({
      where: { id: record.grantId },
      data: blankGrant(),
    }),
    ...endOAuthSignIns([record.id]),
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
    ...endOAuthSignIns(live.map((token) => token.id)),
  ])

  return live.length
}

/**
 * Deletes what an assistant that signed in with OAuth holds for these
 * tokens: every code, access token and refresh token, with the copies of
 * the key in their grants. Deleting the token row alone would leave those
 * grants behind (they hang off the grant, not the token).
 */
export function endOAuthSignIns(tokenIds: string[]) {
  return [
    db().keyGrant.deleteMany({
      where: { oauthCredential: { is: { tokenId: { in: tokenIds } } } },
    }),
    db().oAuthCredential.deleteMany({
      where: { tokenId: { in: tokenIds } },
    }),
  ] as const
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

  await db().$transaction([
    ...endOAuthSignIns([id]),
    db().keyGrant.delete({ where: { id: record.grantId } }),
  ])
}
