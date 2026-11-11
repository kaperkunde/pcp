import { TOOL_TIERS, type ToolTier } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  openTools,
  TOOL_SCHEMA_SELECT,
  TOOL_NAME_SELECT,
  TOOL_ABOUT_SELECT,
  toolNameWhere,
  toolName,
  byToolName,
} from "./tool-rows"
import { ensureDefinition } from "./definition-rows"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import { getSetting, setSetting } from "./settings"
import type { ToolAnnotations } from "./tools/define"
import { readWrapperOperation } from "./wrappers/definition"
import { openServers, SERVER_META_SELECT, byServerSlug } from "./server-meta"

/**
 * How much a tool can do, in three tiers, and the one place that says which
 * a tool is in. Read only reads; Write changes things but deletes nothing
 * for good; Destructive can change or delete things for good.
 *
 * A tool's effective tier is, in order:
 *   1. the owner's choice for it (a `tool_tier` row: per definition, shared
 *      by every instance, or per server for a server without one; PCP's own
 *      tools in the vault's `toolTiers` setting);
 *   2. for a wrapper's tool, the highest tier of the tools its program
 *      calls (a call PCP does not know counts as Destructive); what the
 *      wrapper's definition declares is only a proposal, never the tier;
 *   3. its annotations as MCP reads them: readOnlyHint true is Read, else
 *      destructiveHint false is Write, else Destructive (MCP's defaults: a
 *      tool without hints is Destructive).
 *
 * Everything that asks whether a tool reads, writes or destroys asks here:
 * the entry tools' gate (execute_<tier>, run_<tier>), markedReadOnly
 * (read-only.ts: pacing, a run's trace), the permission page's warning,
 * the wrapper review's badges, describe, list_tools, search and pcp.tools,
 * and the annotations PCP advertises for its own tools. Derived tiers are
 * worked out when asked, never stored.
 */

export { TOOL_TIERS, type ToolTier }

/** As tool-access.ts accessKey, without its imports. */
function accessKey(serverId: string, toolName: string): string {
  return `${serverId}/${toolName}`
}

const RANK: Record<ToolTier, number> = { read: 0, write: 1, destructive: 2 }

export function isToolTier(value: unknown): value is ToolTier {
  return (
    typeof value === "string" &&
    (TOOL_TIERS as readonly string[]).includes(value)
  )
}

/** A tier as sent, or a refusal that names the three. */
export function parseToolTier(value: string): ToolTier {
  if (isToolTier(value)) {
    return value
  }

  throw invalid(
    `"${value}" is not a tier. Use one of ${TOOL_TIERS.join(", ")}.`,
  )
}

export function tierRank(tier: ToolTier): number {
  return RANK[tier]
}

/** The higher of the tiers; Read for none. */
export function highestTier(tiers: Iterable<ToolTier>): ToolTier {
  let highest: ToolTier = "read"

  for (const tier of tiers) {
    if (RANK[tier] > RANK[highest]) {
      highest = tier
    }
  }

  return highest
}

/** Whether an entry tool of one tier may run a tool of another. */
export function tierAllows(entry: ToolTier, tool: ToolTier): boolean {
  return RANK[tool] <= RANK[entry]
}

/**
 * The entry tool that runs a tool of this tier: one of the owner's by
 * call_handle, or one of PCP's own by its name.
 */
export function callEntryFor(tier: ToolTier): string {
  return `execute_${tier}`
}

/** The entry tool whose programs may call tools of this tier. */
export function runEntryFor(tier: ToolTier): string {
  return `run_${tier}`
}

/** search and the execute and run entries, whose tiers are their names. */
export function isEntryName(name: string): boolean {
  return (
    name === "search" ||
    name in RETIRED_ENTRIES ||
    TOOL_TIERS.some(
      (tier) => name === callEntryFor(tier) || name === runEntryFor(tier),
    )
  )
}

/**
 * The entry tools' names before PCP's tools were collapsed into search,
 * execute_<tier> and run_<tier> (#113), each with the one that took over:
 * still answered for one release, unlisted, with a line saying so
 * (docs/breaking-changes.md), then refused.
 */
export const RETIRED_ENTRIES: Readonly<Record<string, string>> = {
  describe: "search",
  call_tool_read: "execute_read",
  call_tool_write: "execute_write",
  call_tool_destructive: "execute_destructive",
  run_code_read: "run_read",
  run_code_write: "run_write",
  run_code_destructive: "run_destructive",
}

/** Annotations as stored (JSON text), read; anything else as none. */
export function parseAnnotations(json: string | null | undefined): unknown {
  if (!json) {
    return undefined
  }

  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/**
 * The tier a tool's annotations give, read as MCP defines them: readOnlyHint
 * true is Read; otherwise destructiveHint false is Write; anything else,
 * hints left out included, is Destructive.
 */
export function tierFromAnnotations(annotations: unknown): ToolTier {
  if (typeof annotations !== "object" || annotations === null) {
    return "destructive"
  }

  const hints = annotations as Record<string, unknown>

  if (hints.readOnlyHint === true) {
    return "read"
  }

  return hints.destructiveHint === false ? "write" : "destructive"
}

/**
 * The read-only and destructive hints that say a tier, over the other two
 * of `base` (whether calling again does the same, whether it reaches
 * outside), for what PCP advertises.
 */
export function tierAnnotations(
  tier: ToolTier,
  base: Pick<ToolAnnotations, "idempotentHint" | "openWorldHint">,
): ToolAnnotations {
  return {
    readOnlyHint: tier === "read",
    destructiveHint: tier === "destructive",
    idempotentHint: base.idempotentHint,
    openWorldHint: base.openWorldHint,
  }
}

/** One tool's tier, and where it comes from. */
export type TierInfo = {
  /** What applies. */
  tier: ToolTier
  /** What applies without the owner's choice. */
  derived: ToolTier
  /** The owner's choice, when there is one. */
  override: ToolTier | null
  /**
   * A wrapper's tool with the owner's choice: the tier its calls came to
   * when they chose, when PCP knows it.
   */
  seen: ToolTier | null
}

/**
 * The effective tier: the owner's choice, else what is derived (a wrapper
 * tool's calls), else the annotations.
 */
export function effectiveTier({
  override,
  derived,
  annotations,
}: {
  override?: ToolTier | null
  derived?: ToolTier | null
  annotations?: unknown
}): ToolTier {
  return override ?? derived ?? tierFromAnnotations(annotations)
}

// ---- Stored choices ---------------------------------------------------------

type Place = { kind: string; definitionId: string | null }
type OverrideRow = {
  definitionId: string | null
  serverId: string | null
  toolName: string
  tier: string
  seenTier: string | null
}
type ToolFacts = { annotations: string | null; operation: string | null }

/**
 * Works out tiers for one vault, reading each server and tool once and the
 * owner's choices once: for a request's whole catalogue, or one call.
 */
function tierResolver(ctx: VaultContext, overrides: OverrideRow[]) {
  const byDefinition = new Map<string, OverrideRow>()
  const byServer = new Map<string, OverrideRow>()

  for (const row of overrides) {
    if (row.definitionId) {
      byDefinition.set(`${row.definitionId}\n${row.toolName}`, row)
    } else if (row.serverId) {
      byServer.set(`${row.serverId}\n${row.toolName}`, row)
    }
  }

  const places = new Map<string, Place | null>()
  const tools = new Map<string, ToolFacts | null>()

  /** Reads the servers and tools not read yet. */
  async function load(serverIds: string[]) {
    const fresh = [...new Set(serverIds)].filter((id) => !places.has(id))

    if (fresh.length === 0) {
      return
    }

    const [servers, rows] = await Promise.all([
      db().mcpServer.findMany({
        where: { id: { in: fresh } },
        select: { id: true, kind: true, definitionId: true },
      }),
      db().mcpTool.findMany({
        where: { serverId: { in: fresh } },
        select: {
          ...TOOL_SCHEMA_SELECT,
          ...TOOL_NAME_SELECT,
          annotations: true,
        },
      }),
    ])

    for (const id of fresh) {
      places.set(id, null)
    }

    for (const server of servers) {
      places.set(server.id, server)
    }

    for (const row of openTools(ctx, rows)) {
      tools.set(accessKey(row.serverId, row.name), row)
    }
  }

  function overrideOf(serverId: string, name: string): OverrideRow | null {
    const place = places.get(serverId)
    const row =
      (place?.definitionId
        ? byDefinition.get(`${place.definitionId}\n${name}`)
        : undefined) ?? byServer.get(`${serverId}\n${name}`)

    return row && isToolTier(row.tier) ? row : null
  }

  async function tierOf(
    serverId: string,
    name: string,
    seen: Set<string> = new Set(),
  ): Promise<TierInfo> {
    await load([serverId])

    const place = places.get(serverId)
    const facts = tools.get(accessKey(serverId, name))
    const chosen = overrideOf(serverId, name)
    const override = chosen ? (chosen.tier as ToolTier) : null
    let derived: ToolTier

    if (!place || !facts) {
      // A tool PCP does not know: nothing says it is harmless.
      derived = "destructive"
    } else if (place.kind === "wrapper") {
      derived = await wrapperDerived(serverId, name, facts, seen)
    } else {
      derived = tierFromAnnotations(parseAnnotations(facts.annotations))
    }

    return {
      tier: override ?? derived,
      derived,
      override,
      seen: chosen && isToolTier(chosen.seenTier) ? chosen.seenTier : null,
    }
  }

  /** A wrapper's tool: the highest tier among the tools it calls. */
  async function wrapperDerived(
    serverId: string,
    name: string,
    facts: ToolFacts,
    seen: Set<string>,
  ): Promise<ToolTier> {
    const key = accessKey(serverId, name)

    if (seen.has(key)) {
      return "destructive"
    }

    const { calls } = readWrapperOperation(facts.operation)
    await load(calls.map((call) => call.serverId))
    const inner = new Set(seen).add(key)
    const tiers: ToolTier[] = []

    for (const call of calls) {
      tiers.push((await tierOf(call.serverId, call.tool, inner)).tier)
    }

    return highestTier(tiers)
  }

  return { load, tierOf }
}

async function overridesOf(vaultId: string): Promise<OverrideRow[]> {
  return db().toolTier.findMany({
    where: { vaultId },
    select: {
      definitionId: true,
      serverId: true,
      toolName: true,
      tier: true,
      seenTier: true,
    },
  })
}

/** One tool's tier and where it comes from. */
export async function toolTierInfo(
  ctx: VaultContext,
  serverId: string,
  toolName: string,
): Promise<TierInfo> {
  const server = await db().mcpServer.findUnique({
    where: { id: serverId },
    select: { vaultId: true },
  })

  if (!server) {
    return {
      tier: "destructive",
      derived: "destructive",
      override: null,
      seen: null,
    }
  }

  return tierResolver(ctx, await overridesOf(server.vaultId)).tierOf(
    serverId,
    toolName,
  )
}

/** One tool's effective tier. */
export async function toolTier(
  ctx: VaultContext,
  serverId: string,
  toolName: string,
): Promise<ToolTier> {
  return (await toolTierInfo(ctx, serverId, toolName)).tier
}

/**
 * Every tool's tier on these servers, keyed by accessKey(serverId, name):
 * for a request's catalogue (gateway-servers.ts) and the owner's pages.
 */
export async function loadToolTiers(
  ctx: VaultContext,
  servers: Array<{ id: string; tools: Array<{ name: string }> }>,
): Promise<Map<string, TierInfo>> {
  const resolver = tierResolver(ctx, await overridesOf(ctx.vaultId))
  await resolver.load(servers.map((server) => server.id))
  const found = new Map<string, TierInfo>()

  for (const server of servers) {
    for (const tool of server.tools) {
      found.set(
        accessKey(server.id, tool.name),
        await resolver.tierOf(server.id, tool.name),
      )
    }
  }

  return found
}

/**
 * The tier of each of a wrapper's calls as it would be now, for a wrapper
 * not made yet (the review of a proposal): the highest of them.
 */
export async function tierOfCalls(
  ctx: VaultContext,
  calls: Array<{ serverId: string; tool: string }>,
): Promise<ToolTier> {
  const resolver = tierResolver(ctx, await overridesOf(ctx.vaultId))
  await resolver.load(calls.map((call) => call.serverId))
  const tiers: ToolTier[] = []

  for (const call of calls) {
    tiers.push((await resolver.tierOf(call.serverId, call.tool)).tier)
  }

  return highestTier(tiers)
}

/**
 * Where a server keeps the owner's tiers: its definition, made now for a
 * server of a kind that has one and has none yet, else the server itself.
 */
async function placeFor(
  ctx: VaultContext,
  serverId: string,
): Promise<{ definitionId: string } | { serverId: string }> {
  const server = await db().mcpServer.findFirst({
    where: { id: serverId, vaultId: ctx.vaultId },
    select: { id: true },
  })

  if (!server) {
    throw notFound("That server")
  }

  const definitionId = await ensureDefinition(ctx, serverId)
  return definitionId ? { definitionId } : { serverId }
}

/**
 * The owner's tier for a tool, or null to go back to the default. On a
 * server with a definition it is the definition's, so every instance of it
 * takes it at once (they read it there), and it outlives the tool dropping
 * out of a refresh. A wrapper's tool keeps the tier its calls come to now,
 * so the header's bell can say when they come to more.
 */
export async function setToolTier(
  ctx: VaultContext,
  serverId: string,
  toolName: string,
  tier: ToolTier | null,
): Promise<void> {
  const place = await placeFor(ctx, serverId)
  const where =
    "definitionId" in place
      ? { definitionId: place.definitionId, toolName }
      : { serverId: place.serverId, toolName }

  if (tier === null) {
    await db().toolTier.deleteMany({
      where: { vaultId: ctx.vaultId, ...where },
    })
    return
  }

  const tool = await db().mcpTool.findFirst({
    where: toolNameWhere(ctx, serverId, toolName),
    select: { id: true },
  })

  if (!tool) {
    throw notFound(`A tool called ${toolName}`)
  }

  const info = await toolTierInfo(ctx, serverId, toolName)
  const server = await db().mcpServer.findUnique({
    where: { id: serverId },
    select: { kind: true },
  })
  const seenTier = server?.kind === "wrapper" ? info.derived : null

  await db().$transaction([
    db().toolTier.deleteMany({ where: { vaultId: ctx.vaultId, ...where } }),
    db().toolTier.create({
      data: { id: newId(), vaultId: ctx.vaultId, ...where, tier, seenTier },
    }),
  ])
}

/**
 * A server that gets a definition of its own (detach) keeps the tiers it
 * had: they are copied from the definition it shared.
 */
export async function copyToolTiers(
  vaultId: string,
  fromDefinitionId: string,
  toDefinitionId: string,
): Promise<void> {
  const rows = await db().toolTier.findMany({
    where: { vaultId, definitionId: fromDefinitionId },
  })

  if (rows.length === 0) {
    return
  }

  await db().toolTier.createMany({
    data: rows.map((row) => ({
      id: newId(),
      vaultId,
      definitionId: toDefinitionId,
      toolName: row.toolName,
      tier: row.tier,
      seenTier: row.seenTier,
    })),
  })
}

/**
 * Definitions merged into one: the kept definition's tiers stay, and a tool
 * only a merged one had a tier for takes it along.
 */
export async function mergeToolTiers(
  vaultId: string,
  keepId: string,
  mergedIds: string[],
): Promise<void> {
  const rows = await db().toolTier.findMany({
    where: { vaultId, definitionId: { in: [keepId, ...mergedIds] } },
    orderBy: { updatedAt: "desc" },
  })
  const taken = new Set(
    rows.filter((row) => row.definitionId === keepId).map((r) => r.toolName),
  )

  for (const row of rows) {
    if (row.definitionId !== keepId && !taken.has(row.toolName)) {
      taken.add(row.toolName)
      await db().toolTier.update({
        where: { id: row.id },
        data: { definitionId: keepId },
      })
    }
  }
}

// ---- PCP's own tools --------------------------------------------------------

/** The vault setting that holds the owner's tiers for PCP's own tools. */
export const SETTING_OWN_TOOL_TIERS = "toolTiers"

/** The owner's tiers for PCP's own tools, by tool name. */
export async function readOwnToolTiers(
  ctx: VaultContext,
): Promise<Record<string, ToolTier>> {
  const stored = await getSetting(ctx, SETTING_OWN_TOOL_TIERS)
  const found: Record<string, ToolTier> = {}

  if (!stored) {
    return found
  }

  try {
    const parsed: unknown = JSON.parse(stored)

    if (typeof parsed === "object" && parsed !== null) {
      for (const [name, tier] of Object.entries(parsed)) {
        // An entry's tier is its name (#113): a choice saved for one, or for
        // an old entry's name, is no choice, and the next save drops it.
        if (isToolTier(tier) && !isEntryName(name)) {
          found[name] = tier
        }
      }
    }
  } catch {
    // A setting that does not read is no choice at all.
  }

  return found
}

/** A name PCP's own tools could have. */
const OWN_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** The owner's tier for one of PCP's own tools, or null for its default. */
export async function setOwnToolTier(
  ctx: VaultContext,
  name: string,
  tier: ToolTier | null,
): Promise<void> {
  if (!OWN_TOOL_NAME.test(name)) {
    throw invalid("That is not one of PCP's tools.")
  }

  const tiers = await readOwnToolTiers(ctx)

  if (tier === null) {
    delete tiers[name]
  } else {
    tiers[name] = tier
  }

  await setSetting(
    ctx,
    SETTING_OWN_TOOL_TIERS,
    Object.keys(tiers).length > 0 ? JSON.stringify(tiers) : null,
  )
}

// ---- The header's bell ------------------------------------------------------

/** A wrapper's tool the owner set below what its calls need now. */
export type TierBelowCalls = {
  serverId: string
  slug: string
  tool: string
  override: ToolTier
  derived: ToolTier
}

/**
 * A wrapper tool's choice below what its calls come to now, where they came
 * to less when the owner chose (or PCP does not know what they came to).
 */
export function tierBelowCalls(info: TierInfo): boolean {
  return (
    info.override !== null &&
    RANK[info.override] < RANK[info.derived] &&
    (info.seen === null || RANK[info.derived] > RANK[info.seen])
  )
}

/**
 * The wrappers' tools whose tier the owner set lower than their calls come
 * to now, where the calls came to less when they chose (or PCP does not
 * know what they came to): a tool a call makes riskier waits for a look.
 * Choosing the tier again records what the calls come to then.
 */
export async function wrapperTiersBelowCalls(
  ctx: VaultContext,
): Promise<TierBelowCalls[]> {
  const overrides = await overridesOf(ctx.vaultId)

  if (overrides.length === 0) {
    return []
  }

  const wrappers = openServers(
    ctx,
    await db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId, kind: "wrapper" },
      select: {
        ...SERVER_META_SELECT,
        definitionId: true,
        tools: { select: TOOL_ABOUT_SELECT },
      },
    }),
  ).sort(byServerSlug)
  const resolver = tierResolver(ctx, overrides)
  const found: TierBelowCalls[] = []

  for (const wrapper of wrappers) {
    for (const tool of wrapper.tools
      .map((row) => ({ name: toolName(ctx, row) }))
      .sort(byToolName)) {
      const info = await resolver.tierOf(wrapper.id, tool.name)

      if (tierBelowCalls(info)) {
        found.push({
          serverId: wrapper.id,
          slug: wrapper.slug,
          tool: tool.name,
          override: info.override!,
          derived: info.derived,
        })
      }
    }
  }

  return found
}
