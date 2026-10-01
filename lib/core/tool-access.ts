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
import { getServer } from "./servers"

/**
 * What each API token may do with each tool: allowed, ask (the default) or
 * blocked. Only allowed and blocked are stored; a tool without a row asks
 * the owner first (lib/core/permissions.ts), and the owner's answer there
 * can settle it for good.
 */

export type TokenToolAccess = {
  name: string
  title: string | null
  access: ToolAccess
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

/** Every stored level for one token, keyed by accessKey(). */
export async function loadToolAccess(
  tokenId: string,
): Promise<Map<string, ToolAccess>> {
  const rows = await db().apiTokenToolAccess.findMany({
    where: { tokenId },
    select: { serverId: true, toolName: true, access: true },
  })

  return new Map(
    rows.map((row) => [
      accessKey(row.serverId, row.toolName),
      row.access as ToolAccess,
    ]),
  )
}

export function effectiveAccess(
  stored: Map<string, ToolAccess>,
  serverId: string,
  toolName: string,
): ToolAccess {
  const access = stored.get(accessKey(serverId, toolName))

  return access === "allowed" || access === "blocked"
    ? access
    : DEFAULT_TOOL_ACCESS
}

/**
 * Stores one level without checking the tool is in the catalogue: the
 * permission flow calls this with a tool it just ran.
 */
export async function writeToolAccess(
  tokenId: string,
  serverId: string,
  toolName: string,
  access: ToolAccess,
): Promise<void> {
  if (access === "ask") {
    await db().apiTokenToolAccess.deleteMany({
      where: { tokenId, serverId, toolName },
    })
    return
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

/** One level for every tool the server has now. */
export async function setServerToolAccess(
  ctx: VaultContext,
  tokenId: string,
  serverId: string,
  access: ToolAccess,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const server = await getServer(ctx, serverId)

  await db().$transaction([
    db().apiTokenToolAccess.deleteMany({ where: { tokenId, serverId } }),
    ...(access !== "ask" && server.tools.length > 0
      ? [
          db().apiTokenToolAccess.createMany({
            data: server.tools.map((tool) => ({
              tokenId,
              serverId,
              toolName: tool.name,
              access,
            })),
          }),
        ]
      : []),
  ])
}

/**
 * Makes one token reach the same servers, with the same tool levels, as
 * another. What the target had before is replaced, not merged.
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
  const stored = await loadToolAccess(tokenId)

  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    slug: server.slug,
    enabled: server.enabled,
    refreshable: canRereadTools(server),
    tools: server.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      access: effectiveAccess(stored, server.id, tool.name),
    })),
  }))
}
