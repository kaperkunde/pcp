import { requireLiveToken, requireToken } from "./api-tokens"
import { canRereadTools } from "./catalogue"
import {
  DEFAULT_TOOL_ACCESS,
  TOOL_ACCESS_LEVELS,
  type ToolAccess,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { byServerName, openServer } from "./server-meta"
import { openTools, TOOL_ABOUT_SELECT, byToolName } from "./tool-rows"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import { getServer } from "./servers"
import { openRuleKey, sealedRuleKey } from "./fetch-rule-keys"
import { levelNameKeys, openLevelName, sealedLevelName } from "./level-names"

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
  rows: Array<{ serverId: string; name: string; access: string }>,
): Map<string, ToolAccess> {
  return new Map(
    rows.flatMap((row) =>
      isLevel(row.access)
        ? [[accessKey(row.serverId, row.name), row.access] as const]
        : [],
    ),
  )
}

/**
 * A level's tool name is kept as a keyed hash with the name sealed beside
 * it (#96): every stored level is opened here, so a lookup is by the name
 * itself; one in the database is by the hash (levelNameKeys).
 */
const ACCESS_SELECT = {
  serverId: true,
  toolName: true,
  sealed: true,
  access: true,
} as const

/** Every stored level for one token: its own, and the ones for all tokens. */
export async function loadToolAccess(
  ctx: VaultContext,
  tokenId: string,
): Promise<StoredAccess> {
  const [own, shared] = await Promise.all([
    db().apiTokenToolAccess.findMany({
      where: { tokenId },
      select: ACCESS_SELECT,
    }),
    db().vaultToolAccess.findMany({
      where: { vaultId: ctx.vaultId },
      select: ACCESS_SELECT,
    }),
  ])

  return {
    own: levelMap(
      own.map((row) => ({
        serverId: row.serverId,
        access: row.access,
        name: openLevelName(
          ctx,
          "api_token_tool_access",
          `${tokenId}:${row.serverId}`,
          { key: row.toolName, sealed: row.sealed },
        ),
      })),
    ),
    shared: levelMap(
      shared.map((row) => ({
        serverId: row.serverId,
        access: row.access,
        name: openLevelName(ctx, "vault_tool_access", row.serverId, {
          key: row.toolName,
          sealed: row.sealed,
        }),
      })),
    ),
  }
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
  ctx: VaultContext,
  tokenId: string,
  serverId: string,
  toolName: string,
  access: ToolAccess,
): Promise<void> {
  const names = levelNameKeys(ctx, serverId, toolName)

  if (access === "ask") {
    // Ask needs a row only to override a level for all tokens.
    const shared = await db().vaultToolAccess.findFirst({
      where: { serverId, toolName: { in: names } },
      select: { access: true },
    })

    if (!shared) {
      await db().apiTokenToolAccess.deleteMany({
        where: { tokenId, serverId, toolName: { in: names } },
      })
      return
    }
  }

  const { key, sealed } = sealedLevelName(
    ctx,
    "api_token_tool_access",
    `${tokenId}:${serverId}`,
    serverId,
    toolName,
  )

  await db().$transaction([
    // One from before, in plain text, gives way to the sealed one.
    db().apiTokenToolAccess.deleteMany({
      where: { tokenId, serverId, toolName, sealed: null },
    }),
    db().apiTokenToolAccess.upsert({
      where: {
        tokenId_serverId_toolName: { tokenId, serverId, toolName: key },
      },
      create: { tokenId, serverId, toolName: key, sealed, access },
      update: { access },
    }),
  ])
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

  await writeToolAccess(ctx, tokenId, serverId, toolName, access)
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
              select: { toolName: true, sealed: true },
            })
          ).map((row) =>
            openLevelName(ctx, "vault_tool_access", serverId, {
              key: row.toolName,
              sealed: row.sealed,
            }),
          ),
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
            data: names.map((name) => {
              const { key, sealed } = sealedLevelName(
                ctx,
                "api_token_tool_access",
                `${tokenId}:${serverId}`,
                serverId,
                name,
              )
              return { tokenId, serverId, toolName: key, sealed, access }
            }),
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
    await loadToolAccess(ctx, tokenId),
    serverId,
    toolName,
  )
  const names = levelNameKeys(ctx, serverId, toolName)
  const own = { tokenId, serverId, toolName: { in: names } }

  if (shared) {
    const { key, sealed } = sealedLevelName(
      ctx,
      "vault_tool_access",
      serverId,
      serverId,
      toolName,
    )

    await db().$transaction([
      // One from before, in plain text, gives way to the sealed one.
      db().vaultToolAccess.deleteMany({
        where: { serverId, toolName, sealed: null },
      }),
      db().vaultToolAccess.upsert({
        where: { serverId_toolName: { serverId, toolName: key } },
        create: {
          vaultId: ctx.vaultId,
          serverId,
          toolName: key,
          sealed,
          access: level,
        },
        update: { access: level },
      }),
      db().apiTokenToolAccess.deleteMany({ where: own }),
    ])
    return
  }

  const mine = sealedLevelName(
    ctx,
    "api_token_tool_access",
    `${tokenId}:${serverId}`,
    serverId,
    toolName,
  )

  await db().$transaction([
    db().vaultToolAccess.deleteMany({
      where: { serverId, toolName: { in: names } },
    }),
    db().apiTokenToolAccess.deleteMany({ where: own }),
    ...(level !== "ask"
      ? [
          db().apiTokenToolAccess.create({
            data: {
              tokenId,
              serverId,
              toolName: mine.key,
              sealed: mine.sealed,
              access: level,
            },
          }),
        ]
      : []),
  ])
}

/**
 * Makes one token reach the same servers, see the same skills, and have the
 * same tool levels and web fetch levels of its own, as another. What the
 * target had before is replaced, not merged; levels for all tokens apply to
 * both already.
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
    include: { servers: true, skills: true, toolAccess: true },
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
      data: {
        allowAllServers: source.allowAllServers,
        allSkills: source.allSkills,
      },
    }),
    db().apiTokenSkill.deleteMany({ where: { tokenId: targetId } }),
    ...(source.skills.length > 0
      ? [
          db().apiTokenSkill.createMany({
            data: source.skills.map((link) => ({
              tokenId: targetId,
              skillId: link.skillId,
            })),
          }),
        ]
      : []),
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
            data: source.toolAccess.map((row) => {
              // A name is sealed to its token's row: sealed again for the copy.
              const { key, sealed } = sealedLevelName(
                ctx,
                "api_token_tool_access",
                `${targetId}:${row.serverId}`,
                row.serverId,
                openLevelName(
                  ctx,
                  "api_token_tool_access",
                  `${sourceId}:${row.serverId}`,
                  { key: row.toolName, sealed: row.sealed },
                ),
              )
              return {
                tokenId: targetId,
                serverId: row.serverId,
                toolName: key,
                sealed,
                access: row.access,
              }
            }),
          }),
        ]
      : []),
    // What the token was allowed for a while goes with the rest of what it
    // had; the source's were answers to its own requests and stay its own.
    db().apiTokenToolAllowance.deleteMany({ where: { tokenId: targetId } }),
    db().apiTokenSiteAllowance.deleteMany({ where: { tokenId: targetId } }),
    db().webFetchRule.deleteMany({ where: { tokenId: targetId } }),
    ...(fetchRules.length > 0
      ? [
          db().webFetchRule.createMany({
            data: fetchRules.map((rule) => {
              // A site's key is sealed to its row: sealed again for the copy.
              const id = newId()
              return {
                id,
                vaultId: ctx.vaultId,
                tokenId: targetId,
                scope: targetId,
                kind: rule.kind,
                ...sealedRuleKey(ctx, id, rule.kind, openRuleKey(ctx, rule)),
                access: rule.access,
                addedBy: rule.addedBy,
              }
            }),
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
      tools: { select: TOOL_ABOUT_SELECT },
    },
  })
  const stored = await loadToolAccess(ctx, tokenId)

  return servers
    .map((row) => ({
      ...openServer(ctx, row),
      tools: openTools(ctx, row.tools).sort(byToolName),
    }))
    .sort(byServerName)
    .map((server) => ({
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
