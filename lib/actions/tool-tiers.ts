"use server"

import { revalidatePath } from "next/cache"

import { chooseOwnToolTier } from "@/lib/core/own-tool-tiers"
import { parseToolTier, setToolTier } from "@/lib/core/tool-tiers"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

export type TierActionResult = ActionState<{ message?: string }>

/** "default" (or nothing) goes back to the tool's own tier. */
function chosenTier(formData: FormData) {
  const value = field(formData, "tier")
  return value === "" || value === "default" ? null : parseToolTier(value)
}

/**
 * The owner's tier for a server's tool: on its definition, so every server
 * of it takes it; "default" takes it away.
 */
export async function setToolTierAction(
  _previous: TierActionResult,
  formData: FormData,
): Promise<TierActionResult> {
  const ctx = await requireContext()
  const serverId = field(formData, "serverId")

  const result = await guarded(async () => {
    const tier = chosenTier(formData)
    await setToolTier(ctx, serverId, field(formData, "tool"), tier)

    return { message: tier ? "Tier saved." : "Back to its own tier." }
  })

  revalidatePath(`/servers/${serverId}`)
  // The header's bell may have a notice less.
  revalidatePath("/", "layout")

  return result
}

/** The owner's tier for one of PCP's own tools; "default" takes it away. */
export async function setOwnToolTierAction(
  _previous: TierActionResult,
  formData: FormData,
): Promise<TierActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const tier = chosenTier(formData)
    await chooseOwnToolTier(ctx, field(formData, "tool"), tier)

    return { message: tier ? "Tier saved." : "Back to its own tier." }
  })

  revalidatePath("/settings")

  return result
}
