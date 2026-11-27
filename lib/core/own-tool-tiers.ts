import { PROGRAM_TOOL_NAMES } from "./program-tools"
import type { ToolTier } from "./constants"
import type { VaultContext } from "./context"
import { invalid } from "./errors"
import { buildGatewayServer, ownToolsOf } from "./gateway"
import { ownToolGuarded } from "./tools/guard"
import {
  readOwnToolTiers,
  setOwnToolTier,
  tierFromAnnotations,
} from "./tool-tiers"

/**
 * PCP's own tools at /mcp that execute_<tier> runs by name (memory,
 * web_fetch, check_permission…; not the entries search, execute_<tier> and
 * run_<tier>, whose tiers are their names) with their tiers, for the
 * owner's Settings:
 * the tier each one's annotations give, and the owner's choice, which
 * becomes what it advertises (gateway.ts ownTiers).
 */

export type OwnToolTier = {
  name: string
  title: string
  /** What its own annotations give. */
  derived: ToolTier
  /** The owner's choice, when there is one. */
  override: ToolTier | null
}

/**
 * Every tool PCP can offer a token, as a token with every right would see
 * it: built as a request would build them, with no servers and nothing of
 * the vault's read but the owner's choices.
 */
function builtOwnTools(ctx: VaultContext) {
  const gateway = buildGatewayServer(
    {
      ctx,
      tokenId: "",
      tokenName: "",
      serverIds: [],
      skillIds: [],
      manageEndpoints: true,
      keepMemories: true,
      memoryMigration: false,
      webFetch: true,
      runCode: true,
      manageWrappers: true,
      shareFiles: true,
      builtinTools: [...PROGRAM_TOOL_NAMES],
      instructions: null,
      clientProfile: null,
      oauthClientName: null,
      clientSeen: null,
      publicUrl: "",
    },
    [],
  )

  return ownToolsOf(gateway)
}

export async function listOwnToolTiers(
  ctx: VaultContext,
): Promise<OwnToolTier[]> {
  const chosen = await readOwnToolTiers(ctx)

  return builtOwnTools(ctx)
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      derived: tierFromAnnotations(tool.annotations),
      override: chosen[tool.name] ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * PCP's own tools the duplicate guard can hold a repeat of back, at the tier
 * they advertise now, the owner's choice first (a tool that is Read, idempotent or declares `never`
 * is left out, as tools/guard.ts decides), by name, for Settings → Repeated
 * calls.
 */
export async function listGuardedOwnTools(
  ctx: VaultContext,
): Promise<Array<{ name: string; title: string }>> {
  const chosen = await readOwnToolTiers(ctx)

  return builtOwnTools(ctx)
    .filter((tool) =>
      ownToolGuarded(
        tool,
        chosen[tool.name] ?? tierFromAnnotations(tool.annotations),
      ),
    )
    .map((tool) => ({ name: tool.name, title: tool.title }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The owner's tier for one of PCP's own tools, or null for its own. */
export async function chooseOwnToolTier(
  ctx: VaultContext,
  name: string,
  tier: ToolTier | null,
): Promise<void> {
  const known = (await listOwnToolTiers(ctx)).some((tool) => tool.name === name)

  // A choice for a tool that is gone may still be taken back.
  if (!known && tier !== null) {
    throw invalid(`PCP has no tool called ${name}.`)
  }

  await setOwnToolTier(ctx, name, tier)
}
