import { toolTier } from "./tool-tiers"

/**
 * Whether a tool is in the Read tier (tool-tiers.ts): the owner's choice,
 * else a wrapper's calls, else its annotations. Pacing (read or change) and
 * a run's trace (what may have taken effect) ask this.
 */
export async function markedReadOnly(
  serverId: string,
  name: string,
): Promise<boolean> {
  return (await toolTier(serverId, name)) === "read"
}
