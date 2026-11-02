import { requireLiveToken } from "./api-tokens"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  TOOL_TIER_LABELS,
  type ToolAccess,
  type ToolTier,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"
import {
  isToolTier,
  loadToolTiers,
  readOwnToolTiers,
  setOwnToolTier,
  setToolTier,
  type TierInfo,
} from "./tool-tiers"
import {
  accessKey,
  listTokenToolAccess,
  parseToolAccess,
  type TokenServerAccess,
} from "./tool-access"

/**
 * An assistant's proposal for its own token's tool levels
 * (propose_tool_access). It can name many tools at once, by name or by
 * pattern, across servers, which is what makes a large catalogue manageable;
 * but it only ever proposes. The proposal is a permission request of kind
 * "access" (lib/core/permissions.ts) whose page fills the levels in, marks
 * what would change, and writes nothing until the owner saves there. No
 * prompt in the client and no panel button can save it, so an assistant
 * cannot raise its own access by answering for the owner.
 *
 * A change may also propose a tool's tier (tool-tiers.ts: Read, Write,
 * Destructive, or back to its default), for many tools at once. The page
 * shows it beside the level, and the owner's save writes the tier they
 * left there: on the tool's definition, so every server of it takes it.
 * PCP's own tools are named on the server "pcp" (when no server has that
 * short name) and keep theirs in the vault's setting.
 */

/** One change as an assistant asks for it: a level, a tier, or both. */
export type AccessChange = {
  /** The server's short name, or "pcp" for PCP's own tools (tiers only). */
  server: string
  /** Tool names or patterns with `*`; every tool on the server when absent. */
  tools?: string[]
  access?: ToolAccess
  /** A tier, or "default" for the tool's own. */
  tier?: TierChoice
}

/** A tier as proposed or chosen: one of the three, or the tool's own. */
export type TierChoice = ToolTier | "default"

/** One tool's tier, resolved: serverId null is one of PCP's own tools. */
export type AccessTier = {
  serverId: string | null
  tool: string
  tier: TierChoice
}

/** The server name an assistant gives PCP's own tools in a proposal. */
export const OWN_TOOLS_SERVER = "pcp"

/** One tool's level, resolved against the catalogue. */
export type AccessLevel = {
  serverId: string
  tool: string
  access: ToolAccess
}

export type AccessAsk = {
  kind: "access"
  /** tiers: absent from a proposal made before tiers. */
  input: { levels: AccessLevel[]; tiers?: AccessTier[] }
}

/** What the resolver reads of a server: the gateway's view of it. */
export type AccessServer = {
  id: string
  slug: string
  tools: Array<{
    name: string
    access: ToolAccess
    /** Its effective tier and the owner's choice, for a tier proposal. */
    tier?: ToolTier
    tierOverride?: ToolTier | null
  }>
}

/** PCP's own tools a token has, with their tiers, for a tier proposal. */
export type AccessOwnTool = {
  name: string
  tier: ToolTier
  override: ToolTier | null
}

export const MAX_ACCESS_CHANGES = 100
export const MAX_ACCESS_PATTERNS = 500
/** The most levels one save may write. */
export const MAX_ACCESS_LEVELS = 20_000

/**
 * A glob where `*` stands for any run of characters, matched in linear time.
 * Not a RegExp: a pattern of many stars backtracks exponentially there, and
 * any token may send one, which would hold the whole process up.
 */
function matcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes("*")) {
    return (name) => name === pattern
  }

  const parts = pattern.split("*")
  const prefix = parts[0]
  const suffix = parts[parts.length - 1]
  const middle = parts.slice(1, -1).filter((part) => part !== "")

  return (name) => {
    if (
      name.length < prefix.length + suffix.length ||
      !name.startsWith(prefix) ||
      !name.endsWith(suffix)
    ) {
      return false
    }

    // Each middle part as early as it fits leaves the most room for the rest.
    const end = name.length - suffix.length
    let at = prefix.length

    for (const part of middle) {
      const found = name.indexOf(part, at)

      if (found === -1 || found + part.length > end) {
        return false
      }

      at = found + part.length
    }

    return true
  }
}

/**
 * Turns an assistant's changes into one level per tool, leaving out the
 * tools that already have the level asked for. Later changes win, so a whole
 * server can be set first and its exceptions after. Blocked tools are hidden
 * from the assistant, so it cannot name them and no pattern reaches them:
 * unblocking one is the owner's to do on the page.
 */
export function resolveAccessChanges(
  servers: AccessServer[],
  changes: AccessChange[],
): AccessLevel[] {
  return resolveAccessProposal(servers, changes).levels
}

/** Whether a proposed tier would change what applies to a tool now. */
function tierChanges(
  choice: TierChoice,
  now: { tier?: ToolTier; override?: ToolTier | null },
): boolean {
  return choice === "default"
    ? (now.override ?? null) !== null
    : now.tier !== choice ||
        ((now.override ?? null) !== null && now.override !== choice)
}

function readTierChoice(value: unknown): TierChoice {
  if (value === "default" || isToolTier(value)) {
    return value
  }

  throw invalid(
    `"${String(value)}" is not a tier. Use read, write, destructive, or default for the tool's own.`,
  )
}

/**
 * Turns an assistant's changes into one level and one tier per tool,
 * leaving out what is already so. Later changes win, so a whole server can
 * be set first and its exceptions after. Blocked tools are hidden from the
 * assistant, so it cannot name them and no pattern reaches them:
 * unblocking one is the owner's to do on the page. PCP's own tools
 * (`ownTools`, server "pcp") take a tier only.
 */
export function resolveAccessProposal(
  servers: AccessServer[],
  changes: AccessChange[],
  ownTools: AccessOwnTool[] = [],
): { levels: AccessLevel[]; tiers: AccessTier[] } {
  if (changes.length === 0) {
    throw invalid("Name at least one change.")
  }

  if (changes.length > MAX_ACCESS_CHANGES) {
    throw invalid(
      `At most ${MAX_ACCESS_CHANGES} changes at once; use patterns such as "list_*" to cover more tools with one.`,
    )
  }

  const bySlug = new Map(servers.map((server) => [server.slug, server]))
  const wanted = new Map<string, AccessLevel>()
  const wantedTiers = new Map<string, AccessTier>()
  // PCP's own tools, as a server called pcp, unless one has that name.
  const own: AccessServer | null =
    ownTools.length > 0 && !bySlug.has(OWN_TOOLS_SERVER)
      ? {
          id: "",
          slug: OWN_TOOLS_SERVER,
          tools: ownTools.map((tool) => ({
            name: tool.name,
            access: "allowed",
            tier: tool.tier,
            tierOverride: tool.override,
          })),
        }
      : null

  for (const change of changes) {
    if (change.access === undefined && change.tier === undefined) {
      throw invalid(
        `Give each change an access level, a tier, or both (the change for ${change.server} has neither).`,
      )
    }

    const access =
      change.access === undefined ? null : parseToolAccess(change.access)
    const tier = change.tier === undefined ? null : readTierChoice(change.tier)
    const isOwn = own !== null && change.server === OWN_TOOLS_SERVER
    const server = isOwn ? own : bySlug.get(change.server)

    if (!server) {
      throw invalid(
        `No server called ${change.server}. Servers: ${[...bySlug.keys(), ...(own ? [`${OWN_TOOLS_SERVER} (PCP's own tools, tiers only)`] : [])].join(", ") || "(none)"}.`,
      )
    }

    if (isOwn && access !== null) {
      throw invalid(
        "PCP's own tools (server pcp) take a tier only: you call them directly, and the owner decides which a token has.",
      )
    }

    const visible = server.tools.filter((tool) => tool.access !== "blocked")
    const patterns = change.tools

    if (patterns && patterns.length > MAX_ACCESS_PATTERNS) {
      throw invalid(
        `At most ${MAX_ACCESS_PATTERNS} tool names in one change; use patterns such as "list_*".`,
      )
    }

    let chosen = visible

    if (patterns && patterns.length > 0) {
      const tests = patterns.map((pattern) => ({
        pattern,
        test: matcher(pattern),
      }))
      const unmatched = tests.filter(
        ({ test }) => !visible.some((tool) => test(tool.name)),
      )

      if (unmatched.length > 0) {
        throw invalid(
          `${server.slug} has no tool matching ${unmatched
            .slice(0, 5)
            .map(({ pattern }) => `"${pattern}"`)
            .join(
              ", ",
            )}${unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ""}. Use search to find the right names.`,
        )
      }

      chosen = visible.filter((tool) =>
        tests.some(({ test }) => test(tool.name)),
      )
    }

    for (const tool of chosen) {
      if (access !== null) {
        wanted.set(accessKey(server.id, tool.name), {
          serverId: server.id,
          tool: tool.name,
          access,
        })
      }

      if (tier !== null) {
        wantedTiers.set(accessKey(server.id, tool.name), {
          serverId: isOwn ? null : server.id,
          tool: tool.name,
          tier,
        })
      }
    }
  }

  const tierNow = new Map(
    [...servers, ...(own ? [own] : [])].flatMap((server) =>
      server.tools.map(
        (tool) => [accessKey(server.id, tool.name), tool] as const,
      ),
    ),
  )
  const tiers = [...wantedTiers.entries()]
    .filter(([key, entry]) => tierChanges(entry.tier, tierNow.get(key) ?? {}))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry)

  const current = new Map(
    servers.flatMap((server) =>
      server.tools.map(
        (tool) => [accessKey(server.id, tool.name), tool.access] as const,
      ),
    ),
  )

  const levels = [...wanted.entries()]
    .filter(([key, level]) => current.get(key) !== level.access)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, level]) => level)

  return { levels, tiers }
}

/** A tier choice in words: "Read", or "its default". */
export function tierChoiceLabel(choice: TierChoice): string {
  return choice === "default" ? "its default" : TOOL_TIER_LABELS[choice]
}

/** "2 to Read, 1 to its default". */
export function countByTier(tiers: Array<{ tier: TierChoice }>): string {
  return (["read", "write", "destructive", "default"] as const)
    .flatMap((choice) => {
      const count = tiers.filter((entry) => entry.tier === choice).length
      return count > 0 ? [`${count} to ${tierChoiceLabel(choice)}`] : []
    })
    .join(", ")
}

/** "3 to Allowed, 1 to Blocked", in the order of the levels. */
export function countByLevel(levels: Array<{ access: ToolAccess }>): string {
  return TOOL_ACCESS_LEVELS.flatMap((access) => {
    const count = levels.filter((level) => level.access === access).length
    return count > 0 ? [`${count} to ${TOOL_ACCESS_LABELS[access]}`] : []
  }).join(", ")
}

function tools(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`
}

const MAX_SERVER_LINES = 20
/** How many tool names the assistant is told a proposal would change. */
export const MAX_LISTED_TOOLS = 500

/**
 * What the assistant reads of its own proposal: each tool that would change,
 * by server and level, so it can check its patterns caught what it meant.
 */
export function listAccessLevels(
  levels: AccessLevel[],
  servers: Array<{ id: string; slug: string }>,
  tiers: AccessTier[] = [],
): string {
  const slugs = new Map(servers.map((server) => [server.id, server.slug]))
  const groups = new Map<string, { label: string; names: string[] }>()
  let listed = 0

  for (const level of levels) {
    if (listed === MAX_LISTED_TOOLS) {
      break
    }

    const key = `${level.serverId}\n${level.access}`
    const group = groups.get(key) ?? {
      label: `${slugs.get(level.serverId) ?? "A server that was removed"}, to ${TOOL_ACCESS_LABELS[level.access]}`,
      names: [],
    }

    group.names.push(level.tool)
    groups.set(key, group)
    listed++
  }

  const tierGroups = new Map<string, { label: string; names: string[] }>()
  let tiersListed = 0

  for (const entry of tiers) {
    if (tiersListed === MAX_LISTED_TOOLS) {
      break
    }

    const key = `${entry.serverId ?? ""}\n${entry.tier}`
    const slug =
      entry.serverId === null
        ? OWN_TOOLS_SERVER
        : (slugs.get(entry.serverId) ?? "A server that was removed")
    const group = tierGroups.get(key) ?? {
      label: `${slug}, to ${tierChoiceLabel(entry.tier)}`,
      names: [],
    }

    group.names.push(entry.tool)
    tierGroups.set(key, group)
    tiersListed++
  }

  return [
    ...(levels.length > 0
      ? [
          "Tools that would change (those already at the level you asked for are left out):",
          ...[...groups.values()].map(
            (group) => `- ${group.label}: ${group.names.join(", ")}`,
          ),
          ...(levels.length > listed
            ? [
                `- and ${levels.length - listed} more, shown to the owner on the page`,
              ]
            : []),
        ]
      : []),
    ...(tiers.length > 0
      ? [
          "Tiers that would change (those already at the tier you asked for are left out):",
          ...[...tierGroups.values()].map(
            (group) => `- ${group.label}: ${group.names.join(", ")}`,
          ),
          ...(tiers.length > tiersListed
            ? [
                `- and ${tiers.length - tiersListed} more, shown to the owner on the page`,
              ]
            : []),
        ]
      : []),
  ].join("\n")
}

/** What the owner and the assistant read about a proposal. */
export function describeAccessAsk(
  levels: AccessLevel[],
  servers: Array<{ id: string; name: string; slug: string }>,
  tiers: AccessTier[] = [],
): { title: string; lines: string[]; warning: string | null } {
  const byId = new Map(servers.map((server) => [server.id, server]))
  const perServer = new Map<string, AccessLevel[]>()

  for (const level of levels) {
    perServer.set(level.serverId, [
      ...(perServer.get(level.serverId) ?? []),
      level,
    ])
  }

  const serverLines = [...perServer.entries()].map(([id, group]) => {
    const server = byId.get(id)
    const label = server
      ? `${server.name} (${server.slug})`
      : "A server that was removed"
    return `${label}: ${countByLevel(group)}`
  })
  const allowed = levels.filter((level) => level.access === "allowed").length

  return {
    title:
      levels.length === 0
        ? "Change what tools are said to do?"
        : "Change which tools an assistant may run?",
    lines: [
      ...(levels.length > 0
        ? [`${tools(levels.length)} would change: ${countByLevel(levels)}`]
        : []),
      ...(tiers.length > 0
        ? [
            `${tools(tiers.length)} would get another tier: ${countByTier(tiers)}. A tier is every token's, and every server of the same definition's.`,
          ]
        : []),
      ...serverLines.slice(0, MAX_SERVER_LINES),
      ...(serverLines.length > MAX_SERVER_LINES
        ? [`And ${serverLines.length - MAX_SERVER_LINES} more servers`]
        : []),
      "Nothing changes until you review the levels in PCP and save them.",
    ],
    warning:
      allowed > 0
        ? `Allowed tools run without asking you. This would allow ${tools(allowed)}; check them before you save.`
        : null,
  }
}

/**
 * The owner's levels as the review page sends them, checked against the
 * tools the token reaches now. Throws on anything else.
 */
export async function checkAccessLevels(
  ctx: VaultContext,
  tokenId: string,
  levels: unknown,
): Promise<AccessLevel[]> {
  if (!Array.isArray(levels)) {
    throw invalid("Send the levels as a list.")
  }

  if (levels.length > MAX_ACCESS_LEVELS) {
    throw invalid("That is more levels than PCP saves at once.")
  }

  const reachable = new Set(
    (await listTokenToolAccess(ctx, tokenId)).flatMap((server) =>
      server.tools.map((tool) => accessKey(server.id, tool.name)),
    ),
  )
  const checked = new Map<string, AccessLevel>()

  for (const entry of levels as unknown[]) {
    const { serverId, tool, access } = (entry ?? {}) as Record<string, unknown>

    if (typeof serverId !== "string" || typeof tool !== "string") {
      throw invalid("Each level names a server and a tool.")
    }

    const key = accessKey(serverId, tool)

    if (!reachable.has(key)) {
      throw invalid(
        `This token no longer reaches ${tool}. Reload the page to see its tools as they are now.`,
      )
    }

    checked.set(key, {
      serverId,
      tool,
      access: parseToolAccess(String(access)),
    })
  }

  return [...checked.values()]
}

/** The PCP tools a token has, by name, as the page and its save know them. */
export type OwnToolNames = () => Promise<string[]>

/**
 * The owner's tiers as the review page sends them, checked against the
 * tools the token reaches now (and PCP's own tools, by `ownNames`). Throws
 * on anything else.
 */
export async function checkAccessTiers(
  ctx: VaultContext,
  tokenId: string,
  tiers: unknown,
  ownNames: OwnToolNames = async () => [],
): Promise<AccessTier[]> {
  if (tiers === undefined || tiers === null) {
    return []
  }

  if (!Array.isArray(tiers)) {
    throw invalid("Send the tiers as a list.")
  }

  if (tiers.length > MAX_ACCESS_LEVELS) {
    throw invalid("That is more tiers than PCP saves at once.")
  }

  const reachable = new Set(
    (await listTokenToolAccess(ctx, tokenId)).flatMap((server) =>
      server.tools.map((tool) => accessKey(server.id, tool.name)),
    ),
  )
  const own = new Set(
    tiers.some((entry) => (entry as { serverId?: unknown })?.serverId === null)
      ? await ownNames()
      : [],
  )
  const checked = new Map<string, AccessTier>()

  for (const entry of tiers as unknown[]) {
    const { serverId, tool, tier } = (entry ?? {}) as Record<string, unknown>

    if (
      (typeof serverId !== "string" && serverId !== null) ||
      typeof tool !== "string"
    ) {
      throw invalid("Each tier names a server and a tool.")
    }

    if (
      serverId === null
        ? !own.has(tool)
        : !reachable.has(accessKey(serverId, tool))
    ) {
      throw invalid(
        `This token no longer reaches ${tool}. Reload the page to see its tools as they are now.`,
      )
    }

    checked.set(accessKey(serverId ?? "", tool), {
      serverId,
      tool,
      tier: readTierChoice(tier),
    })
  }

  return [...checked.values()]
}

/**
 * Writes the owner's tiers: a server's tool on its definition (every server
 * of it), PCP's own in the vault's setting.
 */
export async function writeAccessTiers(
  ctx: VaultContext,
  tiers: AccessTier[],
): Promise<void> {
  for (const entry of tiers) {
    const tier = entry.tier === "default" ? null : entry.tier

    if (entry.serverId === null) {
      await setOwnToolTier(ctx, entry.tool, tier)
    } else {
      await setToolTier(ctx, entry.serverId, entry.tool, tier)
    }
  }
}

/** Writes levels for one token in one transaction. */
export async function writeAccessLevels(
  ctx: VaultContext,
  tokenId: string,
  levels: AccessLevel[],
): Promise<void> {
  await requireLiveToken(ctx, tokenId)

  const byServer = new Map<string, string[]>()

  for (const level of levels) {
    byServer.set(level.serverId, [
      ...(byServer.get(level.serverId) ?? []),
      level.tool,
    ])
  }

  // Ask is stored only where it overrides a level for all tokens; anywhere
  // else it is the absence of a row (lib/core/tool-access.ts).
  const overridden = new Set(
    (
      await db().vaultToolAccess.findMany({
        where: {
          vaultId: ctx.vaultId,
          serverId: { in: [...byServer.keys()] },
        },
        select: { serverId: true, toolName: true },
      })
    ).map((row) => accessKey(row.serverId, row.toolName)),
  )
  const stored = levels.filter(
    (level) =>
      level.access !== "ask" ||
      overridden.has(accessKey(level.serverId, level.tool)),
  )

  await db().$transaction([
    ...[...byServer.entries()].map(([serverId, names]) =>
      db().apiTokenToolAccess.deleteMany({
        where: { tokenId, serverId, toolName: { in: names } },
      }),
    ),
    ...(stored.length > 0
      ? [
          db().apiTokenToolAccess.createMany({
            data: stored.map((level) => ({
              tokenId,
              serverId: level.serverId,
              toolName: level.tool,
              access: level.access,
            })),
          }),
        ]
      : []),
  ])
}

/** What the assistant is told once the owner saved. */
export function describeSavedAccess(
  proposed: AccessLevel[],
  saved: AccessLevel[],
  proposedTiers: AccessTier[] = [],
  savedTiers: AccessTier[] = [],
): string {
  const savedByKey = new Map(
    saved.map((level) => [accessKey(level.serverId, level.tool), level.access]),
  )
  const proposedKeys = new Set(
    proposed.map((level) => accessKey(level.serverId, level.tool)),
  )
  const notTaken = proposed.filter(
    (level) =>
      savedByKey.get(accessKey(level.serverId, level.tool)) !== level.access,
  ).length
  const others = saved.filter(
    (level) => !proposedKeys.has(accessKey(level.serverId, level.tool)),
  ).length

  return [
    saved.length === 0
      ? "The owner saved without changing any tool's level."
      : `The owner saved new levels for ${tools(saved.length)}: ${countByLevel(saved)}.`,
    ...(notTaken > 0
      ? [
          `They did not take ${notTaken} of the ${proposed.length} levels you proposed.`,
        ]
      : saved.length > 0
        ? ["Every level you proposed was saved."]
        : []),
    ...(others > 0
      ? [`They also changed ${tools(others)} you did not name.`]
      : []),
    ...tierSentences(proposedTiers, savedTiers),
  ].join(" ")
}

/** What the assistant hears of the tiers the owner saved. */
function tierSentences(proposed: AccessTier[], saved: AccessTier[]): string[] {
  if (proposed.length === 0 && saved.length === 0) {
    return []
  }

  const key = (entry: AccessTier) => accessKey(entry.serverId ?? "", entry.tool)
  const savedByKey = new Map(saved.map((entry) => [key(entry), entry.tier]))
  const notTaken = proposed.filter(
    (entry) => savedByKey.get(key(entry)) !== entry.tier,
  ).length

  return [
    saved.length === 0
      ? "They changed no tool's tier."
      : `They saved new tiers for ${tools(saved.length)}: ${countByTier(saved)}.`,
    ...(notTaken > 0
      ? [
          `They did not take ${notTaken} of the ${proposed.length} tiers you proposed.`,
        ]
      : []),
  ]
}

/**
 * What the review page shows: every server the token reaches with its tools
 * as they are, and the proposed levels still about tools it reaches.
 */
export async function accessReview(
  ctx: VaultContext,
  tokenId: string,
  proposed: AccessLevel[],
  proposedTiers: AccessTier[] = [],
  ownTools: Array<{ name: string; title: string; derived: ToolTier }> = [],
): Promise<{
  servers: TokenServerAccess[]
  proposed: AccessLevel[]
  /** Proposed levels for tools the token no longer reaches. */
  gone: number
  /** Each tool's tier now, by accessKey(serverId, name). */
  tiers: Record<string, ShownTierNow>
  /** Proposed tiers still about tools the token reaches. */
  proposedTiers: AccessTier[]
  /** PCP's own tools whose tier was proposed, with theirs now. */
  ownTools: Array<{ name: string; title: string } & ShownTierNow>
  /** Per server: the other servers its definition's tiers reach, by name. */
  sharedWith: Record<string, string[]>
}> {
  const servers = await listTokenToolAccess(ctx, tokenId)
  const reachable = new Set(
    servers.flatMap((server) =>
      server.tools.map((tool) => accessKey(server.id, tool.name)),
    ),
  )
  const kept = proposed.filter((level) =>
    reachable.has(accessKey(level.serverId, level.tool)),
  )
  const loaded = await loadToolTiers(ctx.vaultId, servers)
  const tiers: Record<string, ShownTierNow> = {}

  for (const [key, info] of loaded) {
    tiers[key] = shownNow(info)
  }

  const chosenOwn = await readOwnToolTiers(ctx)
  const proposedOwn = new Set(
    proposedTiers
      .filter((entry) => entry.serverId === null)
      .map((entry) => entry.tool),
  )
  const own = ownTools
    .filter((tool) => proposedOwn.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      tier: chosenOwn[tool.name] ?? tool.derived,
      derived: tool.derived,
      override: chosenOwn[tool.name] ?? null,
    }))
  const ownNames = new Set(own.map((tool) => tool.name))
  const keptTiers = proposedTiers.filter((entry) =>
    entry.serverId === null
      ? ownNames.has(entry.tool)
      : reachable.has(accessKey(entry.serverId, entry.tool)),
  )

  return {
    servers,
    proposed: kept,
    gone:
      proposed.length - kept.length + (proposedTiers.length - keptTiers.length),
    tiers,
    proposedTiers: keptTiers,
    ownTools: own,
    sharedWith: await sharedInstances(
      ctx,
      servers.map((server) => server.id),
    ),
  }
}

/** A tool's tier now, as the review page shows it. */
export type ShownTierNow = {
  tier: ToolTier
  derived: ToolTier
  override: ToolTier | null
}

function shownNow(info: TierInfo): ShownTierNow {
  return { tier: info.tier, derived: info.derived, override: info.override }
}

/** For each server, the names of the other servers of its definition. */
async function sharedInstances(
  ctx: VaultContext,
  serverIds: string[],
): Promise<Record<string, string[]>> {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, definitionId: { not: null } },
    select: { id: true, name: true, definitionId: true },
  })
  const found: Record<string, string[]> = {}

  for (const id of serverIds) {
    const own = rows.find((row) => row.id === id)
    const others = own
      ? rows
          .filter(
            (row) => row.definitionId === own.definitionId && row.id !== id,
          )
          .map((row) => row.name)
      : []

    if (others.length > 0) {
      found[id] = others
    }
  }

  return found
}
