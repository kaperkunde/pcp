"use server"

import { revalidatePath } from "next/cache"

import {
  createSshExit,
  deleteExit,
  setExitLevel,
  setExitLevelShared,
  updateExit,
} from "@/lib/core/exits/exits"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * Exits (lib/core/exits/): the owner adds, renames and removes them on an
 * SSH server's page, and sets each token's level for them on its page.
 */

function revalidate(serverId?: string) {
  if (serverId) revalidatePath(`/servers/${serverId}`)
  revalidatePath("/tokens")
  revalidatePath("/tokens/[id]", "page")
}

export async function createExitAction(
  serverId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await createSshExit(ctx, {
      serverId,
      name: field(formData, "name"),
      label: field(formData, "label"),
    })
    return {}
  })

  revalidate(serverId)
  return result
}

export async function updateExitAction(
  serverId: string,
  exitId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await updateExit(ctx, exitId, {
      name: field(formData, "name"),
      label: field(formData, "label"),
    })
    return {}
  })

  revalidate(serverId)
  return result
}

export async function deleteExitAction(
  serverId: string,
  exitId: string,
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await deleteExit(ctx, exitId)
    return {}
  })

  revalidate(serverId)
  return result
}

export async function setExitLevelAction(
  tokenId: string,
  exitId: string,
  access: string,
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await setExitLevel(ctx, tokenId, exitId, access)
    return {}
  })

  revalidate()
  return result
}

export async function setExitLevelSharedAction(
  tokenId: string,
  exitId: string,
  shared: boolean,
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await setExitLevelShared(ctx, tokenId, exitId, shared)
    return {}
  })

  revalidate()
  return result
}
