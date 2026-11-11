"use server"

import { revalidatePath } from "next/cache"

import {
  createSshExit,
  setExitLevel,
  setExitLevelShared,
  updateExit,
} from "@/lib/core/exits/exits"
import { removeExit } from "@/lib/core/upstream"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
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

/**
 * Removes an exit; a VPN service's exit takes its service with it when the
 * owner chose so (its container removed from the SSH server first).
 */
export async function deleteExitAction(
  serverId: string,
  exitId: string,
  choices: { service?: boolean } = {},
): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => ({
    message: await removeExit(
      ctx,
      exitId,
      { service: choices.service === true },
      { publicUrl: await publicUrlFor(ctx) },
    ),
  }))

  revalidate(serverId)
  revalidatePath("/servers")
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
