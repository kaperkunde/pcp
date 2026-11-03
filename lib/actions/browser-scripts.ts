"use server"

import { revalidatePath } from "next/cache"

import { removeScriptSite } from "@/lib/core/browser-scripts"
import { guarded, type ActionState } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * "Take back" on a site where the owner allowed or blocked an assistant's
 * scripts (the browser's evaluate): it asks again there.
 */
export async function removeScriptSiteAction(
  tokenId: string,
  site: string,
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await removeScriptSite(ctx, String(tokenId), String(site))
    return {}
  })

  revalidatePath(`/tokens/${tokenId}`)
  return result
}
