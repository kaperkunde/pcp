import { z } from "zod"

import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound } from "../errors"
import { getSetting, setSetting } from "../settings"
import { accessKey } from "../tool-access"
import { loadToolTiers } from "../tool-tiers"
import {
  DUPLICATE_CALL_MS,
  DUPLICATE_WINDOW_MINUTES,
  MAX_GUARD_OVERRIDES,
  UNGUARDED_KINDS,
} from "./limits"

/**
 * The owner's own windows for the duplicate guard (guard.ts), kept as the
 * vault's setting SETTING_DUPLICATE_CALLS: a default of their own for every
 * tool, and per tool, by server id and name (accessKey), minutes of its own
 * or "exempt" (never held back). It names the owner's servers, so it is the
 * vault's, never the machine's. What the owner did not set follows
 * DUPLICATE_CALL_MS. Edited on Settings → Repeated calls.
 */

export const SETTING_DUPLICATE_CALLS = "duplicateCalls"

export type GuardOverride = number | "exempt"

export type DuplicateCallsConfig = {
  /** The owner's own default, in minutes; PCP's when left out. */
  defaultMinutes?: number
  /** By accessKey(serverId, tool): minutes, or "exempt". */
  tools: Record<string, GuardOverride>
}

export const EMPTY_DUPLICATE_CALLS: DuplicateCallsConfig = { tools: {} }

const Minutes = z
  .number()
  .int()
  .min(DUPLICATE_WINDOW_MINUTES.min)
  .max(DUPLICATE_WINDOW_MINUTES.max)

const OverrideSchema = z.union([z.literal("exempt"), Minutes])

const ConfigSchema = z.strictObject({
  defaultMinutes: Minutes.optional(),
  tools: z.record(z.string().min(3).max(400), OverrideSchema),
})

const DEFAULT_MINUTES = DUPLICATE_CALL_MS / 60_000

function outOfBounds(): Error {
  return invalid(
    `Keep the time between ${DUPLICATE_WINDOW_MINUTES.min} minute and ${DUPLICATE_WINDOW_MINUTES.max / 60} hours.`,
  )
}

/**
 * The vault's setting, sealed under its key (lib/core/settings.ts); one
 * that does not read as one (a hand-edited export) counts as none, which
 * is PCP's default for every tool.
 */
export async function readDuplicateCalls(
  ctx: VaultContext,
): Promise<DuplicateCallsConfig> {
  const raw = await getSetting(ctx, SETTING_DUPLICATE_CALLS)

  if (!raw) {
    return EMPTY_DUPLICATE_CALLS
  }

  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : EMPTY_DUPLICATE_CALLS
  } catch {
    return EMPTY_DUPLICATE_CALLS
  }
}

/** The window every tool without one of its own follows, in ms. */
export function defaultWindowMs(config: DuplicateCallsConfig): number {
  return config.defaultMinutes === undefined
    ? DUPLICATE_CALL_MS
    : config.defaultMinutes * 60_000
}

/** How long a tool's calls are remembered, or null when never. */
export function guardWindowMs(
  config: DuplicateCallsConfig,
  serverId: string,
  tool: string,
): number | null {
  const own = config.tools[accessKey(serverId, tool)]

  if (own === "exempt") {
    return null
  }

  return own === undefined ? defaultWindowMs(config) : own * 60_000
}

async function writeConfig(
  ctx: VaultContext,
  config: DuplicateCallsConfig,
): Promise<void> {
  const empty =
    config.defaultMinutes === undefined &&
    Object.keys(config.tools).length === 0

  await setSetting(
    ctx,
    SETTING_DUPLICATE_CALLS,
    empty ? null : JSON.stringify(ConfigSchema.parse(config)),
  )
}

/** The owner's default for every tool, or null for PCP's. */
export async function setDuplicateCallDefault(
  ctx: VaultContext,
  minutes: number | null,
): Promise<void> {
  if (minutes !== null && !Minutes.safeParse(minutes).success) {
    throw outOfBounds()
  }

  const { defaultMinutes: _old, ...config } = await readDuplicateCalls(ctx)

  await writeConfig(
    ctx,
    minutes === null || minutes === DEFAULT_MINUTES
      ? config
      : { ...config, defaultMinutes: minutes },
  )
}

/**
 * One tool's window: minutes of its own, "exempt", or null for the default.
 * Tools of servers no longer in the vault are dropped as it is written.
 */
export async function setDuplicateCallWindow(
  ctx: VaultContext,
  serverId: string,
  tool: string,
  value: GuardOverride | null,
): Promise<void> {
  const servers = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId },
    select: { id: true },
  })
  const ids = new Set(servers.map((row) => row.id))

  if (!ids.has(serverId)) {
    throw notFound("That server")
  }

  if (tool === "" || tool.length > 200) {
    throw invalid("Choose a tool.")
  }

  if (value !== null && !OverrideSchema.safeParse(value).success) {
    throw outOfBounds()
  }

  const config = await readDuplicateCalls(ctx)
  const key = accessKey(serverId, tool)
  const tools: Record<string, GuardOverride> = {}

  for (const [name, override] of Object.entries(config.tools)) {
    const id = name.slice(0, name.indexOf("/"))

    if (ids.has(id) && name !== key) {
      tools[name] = override
    }
  }

  if (value !== null) {
    if (Object.keys(tools).length >= MAX_GUARD_OVERRIDES) {
      throw invalid(
        `At most ${MAX_GUARD_OVERRIDES} tools have a time of their own.`,
      )
    }

    tools[key] = value
  }

  await writeConfig(ctx, { ...config, tools })
}

export type DuplicateCallsTool = {
  /** accessKey(serverId, tool). */
  key: string
  serverId: string
  server: string
  tool: string
}

export type DuplicateCallsOverview = {
  /** The default every tool follows now, in minutes. */
  defaultMinutes: number
  /** PCP's own default, in minutes. */
  pcpDefaultMinutes: number
  /** The owner set the default. */
  ownDefault: boolean
  bounds: { min: number; max: number }
  /** The tools with their own, by server and tool name. */
  tools: Array<DuplicateCallsTool & { value: GuardOverride }>
  /** The tools the guard holds back, to choose from. */
  choices: DuplicateCallsTool[]
}

/**
 * What Settings → Repeated calls shows: the default, the tools with their
 * own, and the tools that can have one (every tool of the vault that
 * changes things, on a kind of server the guard watches).
 */
export async function duplicateCallsOverview(
  ctx: VaultContext,
): Promise<DuplicateCallsOverview> {
  const config = await readDuplicateCalls(ctx)
  const servers = (
    await db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId },
      select: {
        id: true,
        name: true,
        kind: true,
        tools: { select: { name: true }, orderBy: { name: "asc" } },
      },
      orderBy: { name: "asc" },
    })
  ).filter((server) => !UNGUARDED_KINDS.has(server.kind))
  const tiers = await loadToolTiers(ctx.vaultId, servers)
  const choices: DuplicateCallsTool[] = []
  const known = new Map<string, DuplicateCallsTool>()

  for (const server of servers) {
    for (const tool of server.tools) {
      const entry = {
        key: accessKey(server.id, tool.name),
        serverId: server.id,
        server: server.name,
        tool: tool.name,
      }
      known.set(entry.key, entry)

      if (tiers.get(entry.key)?.tier !== "read") {
        choices.push(entry)
      }
    }
  }

  return {
    defaultMinutes: defaultWindowMs(config) / 60_000,
    pcpDefaultMinutes: DEFAULT_MINUTES,
    ownDefault: config.defaultMinutes !== undefined,
    bounds: DUPLICATE_WINDOW_MINUTES,
    tools: Object.entries(config.tools).flatMap(([key, value]) => {
      const entry = known.get(key)
      return entry ? [{ ...entry, value }] : []
    }),
    choices,
  }
}
