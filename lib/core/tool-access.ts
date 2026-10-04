import { requireLiveToken, requireToken } from "./api-tokens"
import { canRereadTools } from "./catalogue"
import {
  DEFAULT_TOOL_ACCESS,
  TOOL_ACCESS_LEVELS,
  type ToolAccess,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import { getServer } from "./servers"

/**
 * What each API token may do with each tool: allowed, ask (the default) or
 * blocked. A level is the token's own, or the tool's level for all tokens
 * ("All tokens" on a token's page), and the token's own wins: a specific
 * line beats the general one. A tool with neither asks the owner first
 * (lib/core/permissions.ts), and the owner's answer there can settle it for
 * the token for good.
 *
 * A token's own `ask` is only stored while there is a level for all tokens
 * for it to override; otherwise ask is the absence of a row.
 */

export type TokenToolAccess = {
  name: string
  title: string | null
  /** What applies: the token's own level, else the one for all tokens. */
  access: ToolAccess
  /** The token's own level, when it has one. */
  own: ToolAccess | null
  /** The level for all tokens, when there is one. */
  shared: ToolAccess | null
}

/** A token's own levels and the ones for all tokens, keyed by accessKey(). */
export type StoredAccess = {
  own: Map<string, ToolAccess>
  shared: Map<string, ToolAccess>
}

export type TokenServerAccess = {
  id: string
  name: string
  slug: string
  enabled: boolean
  /** Whether the owner can read its tools again from here. */
  refreshable: boolean
  tools: TokenToolAccess[]
}

export function accessKey(serverId: string, toolName: string): string {
  return `${serverId}/${toolName}`
}

export function parseToolAccess(value: string): ToolAccess {
  if ((TOOL_ACCESS_LEVELS as readonly string[]).includes(value)) {
    return value as ToolAccess
  }

  throw invalid("Choose Allowed, Ask you first or Blocked.")
}

function isLevel(value: string): value is ToolAccess {
  return (TOOL_ACCESS_LEVELS as readonly string[]).includes(value)
}

function levelMap(
  rows: Array<{ serverId: string; toolName: string; access: string }>,
): Map<string, ToolAccess> {
  return new Map(
    rows.flatMap((row) =>
      isLevel(row.access)
        ? [[accessKey(row.serverId, row.toolName), row.access] as const]
        : [],
    ),
  )
}

/** Every stored level for one token: its own, and the ones for all tokens. */
export async function loadToolAccess(
  vaultId: string,
  tokenId: string,
): Promise<StoredAccess> {
  const select = { serverId: true, toolName: true, access: true } as const
  const [own, shared] = await Promise.all([
    db().apiTokenToolAccess.findMany({ where: { tokenId }, select }),
    db().vaultToolAccess.findMany({ where: { vaultId }, select }),
  ])

  return { own: levelMap(own), shared: levelMap(shared) }
}

export function effectiveAccess(
  stored: StoredAccess,
  serverId: string,
  toolName: string,
): ToolAccess {
  const key = accessKey(serverId, toolName)

  return stored.own.get(key) ?? stored.shared.get(key) ?? DEFAULT_TOOL_ACCESS
}

/**
 * Stores one of the token's own levels without checking the tool is in the
 * catalogue: the permission flow calls this with a tool it just ran.
 */
export async function writeToolAccess(
  tokenId: string,
  serverId: string,
  toolName: string,
  access: ToolAccess,
): Promise<void> {
  if (access === "ask") {
    // Ask needs a row only to override a level for all tokens.
    const shared = await db().vaultToolAccess.findUnique({
      where: { serverId_toolName: { serverId, toolName } },
      select: { access: true },
    })

    if (!shared) {
      await db().apiTokenToolAccess.deleteMany({
        where: { tokenId, serverId, toolName },
      })
      return
    }
  }

  await db().apiTokenToolAccess.upsert({
    where: { tokenId_serverId_toolName: { tokenId, serverId, toolName } },
    create: { tokenId, serverId, toolName, access },
    update: { access },
  })
}

export async function setToolAccess(
  ctx: VaultContext,
  tokenId: string,
  serverId: string,
  toolName: string,
  access: ToolAccess,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const server = await getServer(ctx, serverId)

  if (!server.tools.some((tool) => tool.name === toolName)) {
    throw notFound("That tool")
  }

  await writeToolAccess(tokenId, serverId, toolName, access)
}

/** One level, the token's own, for every tool the server has now. */
export async function setServerToolAccess(
  ctx: VaultContext,
  tokenId: string,
  serverId: string,
  access: ToolAccess,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const server = await getServer(ctx, serverId)
  // Ask is stored only where it overrides a level for all tokens.
  const overridden =
    access === "ask"
      ? new Set(
          (
            await db().vaultToolAccess.findMany({
              where: { serverId },
              select: { toolName: true },
            })
          ).map((row) => row.toolName),
        )
      : null
  const names = server.tools
    .map((tool) => tool.name)
    .filter((name) => overridden === null || overridden.has(name))

  await db().$transaction([
    db().apiTokenToolAccess.deleteMany({ where: { tokenId, serverId } }),
    ...(names.length > 0
      ? [
          db().apiTokenToolAccess.createMany({
            data: names.map((toolName) => ({
              tokenId,
              serverId,
              toolName,
              access,
            })),
          }),
        ]
      : []),
  ])
}

/**
 * The "All tokens" box on a tool's row. Ticked, the level that applies to
 * this token now becomes the tool's level for every token, and the token's
 * own level goes (other tokens' own levels still win over it). Unticked,
 * the level for all tokens goes and this token keeps what it had as its
 * own, so nothing changes for it.
 */
export async function setToolAccessShared(
  ctx: VaultContext,
  tokenId: string,
  serverId: string,
  toolName: string,
  shared: boolean,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const server = await getServer(ctx, serverId)

  if (!server.tools.some((tool) => tool.name === toolName)) {
    throw notFound("That tool")
  }

  const level = effectiveAccess(
    await loadToolAccess(ctx.vaultId, tokenId),
    serverId,
    toolName,
  )
  const own = { tokenId, serverId, toolName }

  if (shared) {
    await db().$transaction([
      db().vaultToolAccess.upsert({
        where: { serverId_toolName: { serverId, toolName } },
        create: { vaultId: ctx.vaultId, serverId, toolName, access: level },
        update: { access: level },
      }),
      db().apiTokenToolAccess.deleteMany({ where: own }),
    ])
    return
  }

  await db().$transaction([
    db().vaultToolAccess.deleteMany({ where: { serverId, toolName } }),
    db().apiTokenToolAccess.deleteMany({ where: own }),
    ...(level !== "ask"
      ? [db().apiTokenToolAccess.create({ data: { ...own, access: level } })]
      : []),
  ])
}

/**
 * Makes one token reach the same servers, with the same tool levels and web
 * fetch levels of its own, as another. What the target had before is
 * replaced, not merged; levels for all tokens apply to both already.
 */
export async function copyTokenAccess(
  ctx: VaultContext,
  targetId: string,
  sourceId: string,
): Promise<void> {
  if (targetId === sourceId) {
    throw invalid("Choose a different token to copy from.")
  }

  await requireLiveToken(ctx, targetId)
  const source = await db().apiToken.findFirst({
    where: { id: sourceId, vaultId: ctx.vaultId },
    include: { servers: true, toolAccess: true },
  })

  if (!source) {
    throw notFound("The token to copy from")
  }

  const fetchRules = await db().webFetchRule.findMany({
    where: { vaultId: ctx.vaultId, tokenId: sourceId },
  })

  await db().$transaction([
    db().apiToken.update({
      where: { id: targetId },
      data: { allowAllServers: source.allowAllServers },
    }),
    db().apiTokenServer.deleteMany({ where: { tokenId: targetId } }),
    ...(source.servers.length > 0
      ? [
          db().apiTokenServer.createMany({
            data: source.servers.map((link) => ({
              tokenId: targetId,
              serverId: link.serverId,
            })),
          }),
        ]
      : []),
    db().apiTokenToolAccess.deleteMany({ where: { tokenId: targetId } }),
    ...(source.toolAccess.length > 0
      ? [
          db().apiTokenToolAccess.createMany({
            data: source.toolAccess.map((row) => ({
              tokenId: targetId,
              serverId: row.serverId,
              toolName: row.toolName,
              access: row.access,
            })),
          }),
        ]
      : []),
    db().webFetchRule.deleteMany({ where: { tokenId: targetId } }),
    ...(fetchRules.length > 0
      ? [
          db().webFetchRule.createMany({
            data: fetchRules.map((rule) => ({
              id: newId(),
              vaultId: ctx.vaultId,
              tokenId: targetId,
              scope: targetId,
              kind: rule.kind,
              key: rule.key,
              access: rule.access,
              addedBy: rule.addedBy,
            })),
          }),
        ]
      : []),
  ])
}

/** The servers a token reaches, each with every tool and its level. */
export async function listTokenToolAccess(
  ctx: VaultContext,
  tokenId: string,
): Promise<TokenServerAccess[]> {
  await requireToken(ctx, tokenId)
  const token = await db().apiToken.findUniqueOrThrow({
    where: { id: tokenId },
    include: { servers: { select: { serverId: true } } },
  })
  const servers = await db().mcpServer.findMany({
    where: {
      vaultId: ctx.vaultId,
      ...(token.allowAllServers
        ? {}
        : { id: { in: token.servers.map((link) => link.serverId) } }),
    },
    include: {
      tools: { select: { name: true, title: true }, orderBy: { name: "asc" } },
    },
    orderBy: { name: "asc" },
  })
  const stored = await loadToolAccess(ctx.vaultId, tokenId)

  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    slug: server.slug,
    enabled: server.enabled,
    refreshable: canRereadTools(server),
    tools: server.tools.map((tool) => {
      const key = accessKey(server.id, tool.name)

      return {
        name: tool.name,
        title: tool.title,
        access: effectiveAccess(stored, server.id, tool.name),
        own: stored.own.get(key) ?? null,
        shared: stored.shared.get(key) ?? null,
      }
    }),
  }))
}
