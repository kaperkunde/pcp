"use server"

import { revalidatePath } from "next/cache"

import { invalid } from "@/lib/core/errors"
import { endServerCooling, saveOwnerLimits } from "@/lib/core/gate/proposals"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * A server's limits (lib/core/gate/): the owner's own, from the Limits
 * section of its page. What is sent is checked in core.
 */

export type LimitsResult = ActionState<{ message?: string }>

export async function saveServerLimitsAction(
  _previous: LimitsResult,
  formData: FormData,
): Promise<LimitsResult> {
  const ctx = await requireContext()
  const serverId = field(formData, "serverId")

  const result = await guarded(async () => {
    let limits: unknown

    try {
      limits = JSON.parse(field(formData, "limits") || "{}")
    } catch {
      throw invalid("The limits could not be read; reload the page.")
    }

    await saveOwnerLimits(ctx, serverId, limits)
    return { message: "Saved. Calls from now on keep to these limits." }
  })

  revalidatePath(`/servers/${serverId}`)
  return result
}

export async function endCoolingAction(
  serverId: string,
): Promise<LimitsResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await endServerCooling(ctx, serverId)
    return { message: "Calls to it go through again." }
  })

  revalidatePath(`/servers/${serverId}`)
  return result
}
