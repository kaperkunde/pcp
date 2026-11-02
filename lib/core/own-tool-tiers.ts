import type { ToolTier } from "./constants"
import type { VaultContext } from "./context"
import { invalid } from "./errors"
import { buildGatewayServer, ownToolsOf } from "./gateway"
import {
  readOwnToolTiers,
  setOwnToolTier,
  tierFromAnnotations,
} from "./tool-tiers"

/**
 * PCP's own tools at /mcp (search, describe, the call_tool and run_code
 * entries, memory, web_fetch…) with their tiers, for the owner's Settings:
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
export async function listOwnToolTiers(
  ctx: VaultContext,
): Promise<OwnToolTier[]> {
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
      instructions: null,
      publicUrl: "",
    },
    [],
  )
  const chosen = await readOwnToolTiers(ctx)

  return ownToolsOf(gateway)
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      derived: tierFromAnnotations(tool.annotations),
      override: chosen[tool.name] ?? null,
    }))
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
