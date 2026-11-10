import { z } from "zod"

import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound } from "../errors"
import { getVaultSetting, setSetting } from "../settings"
import { accessKey } from "../tool-access"
import {
  DUPLICATE_CALL_MS,
  DUPLICATE_WINDOW_MINUTES,
  MAX_GUARD_OVERRIDES,
} from "./limits"

/**
 * The owner's own windows for the duplicate guard (guard.ts), kept as the
 * vault's setting SETTING_DUPLICATE_CALLS: per tool, by server id and name
 * (accessKey), either minutes of its own or "exempt" (never guarded). It
 * names the owner's servers, so it is the vault's, never the machine's.
 * What the owner did not set follows DUPLICATE_CALL_MS.
 */

export const SETTING_DUPLICATE_CALLS = "duplicateCalls"

export type GuardOverride = number | "exempt"

export type DuplicateCallsConfig = {
  /** By accessKey(serverId, tool): minutes, or "exempt". */
  tools: Record<string, GuardOverride>
}

export const EMPTY_DUPLICATE_CALLS: DuplicateCallsConfig = { tools: {} }

const OverrideSchema = z.union([
  z.literal("exempt"),
  z
    .number()
    .int()
    .min(DUPLICATE_WINDOW_MINUTES.min)
    .max(DUPLICATE_WINDOW_MINUTES.max),
])

const ConfigSchema = z.strictObject({
  tools: z.record(z.string().min(3).max(400), OverrideSchema),
})

/**
 * The vault's setting, read without the vault key (settings are not
 * encrypted); one that does not read as one (a hand-edited export) counts
 * as none, which is PCP's default for every tool.
 */
export async function readDuplicateCalls(
  vaultId: string,
): Promise<DuplicateCallsConfig> {
  const raw = await getVaultSetting(vaultId, SETTING_DUPLICATE_CALLS)

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

  return own === undefined ? DUPLICATE_CALL_MS : own * 60_000
}

/**
 * One tool's window: minutes of its own, "exempt", or null for PCP's
 * default. Tools of servers no longer in the vault are dropped as it is
 * written.
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
    throw invalid("Name the tool.")
  }

  if (value !== null && !OverrideSchema.safeParse(value).success) {
    throw invalid(
      `Keep the time between ${DUPLICATE_WINDOW_MINUTES.min} minute and ${DUPLICATE_WINDOW_MINUTES.max / 60} hours, or turn the check off for this tool.`,
    )
  }

  const config = await readDuplicateCalls(ctx.vaultId)
  const key = accessKey(serverId, tool)
  const tools: Record<string, GuardOverride> = {}

  for (const [name, override] of Object.entries(config.tools)) {
    const id = name.slice(0, name.indexOf("/"))

    if (ids.has(id) && name !== key) {
      tools[name] = override
    }
  }

  if (value !== null && value !== DUPLICATE_CALL_MS / 60_000) {
    if (Object.keys(tools).length >= MAX_GUARD_OVERRIDES) {
      throw invalid(
        `At most ${MAX_GUARD_OVERRIDES} tools have a time of their own.`,
      )
    }

    tools[key] = value
  }

  await setSetting(
    ctx,
    SETTING_DUPLICATE_CALLS,
    Object.keys(tools).length === 0
      ? null
      : JSON.stringify(ConfigSchema.parse({ tools })),
  )
}
