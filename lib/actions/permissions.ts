"use server"

import { revalidatePath } from "next/cache"

import { notFound } from "@/lib/core/errors"
import { parseDecision } from "@/lib/core/permission-rules"
import {
  applyAccessRequest,
  decidePermission,
  getPermissionView,
} from "@/lib/core/permissions"
import { type ActionState, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export type DecidePermissionResult = ActionState<{
  message: string
  isError: boolean
}>

/**
 * The owner's answer on /permissions/<id> or the token page to something an
 * assistant asked for (lib/core/permissions.ts). Only the signed-in owner
 * reaches this; the answer runs the call there and then.
 */
export async function decidePermissionAction(
  id: string,
  decision: string,
): Promise<DecidePermissionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)

  const result = await guarded(async () => {
    const view = await getPermissionView(ctx, id, { publicUrl })

    if (!view) {
      throw notFound("That request")
    }

    const outcome = await decidePermission(
      ctx,
      id,
      parseDecision(view.kind, decision),
      { via: "web", publicUrl },
    )
    const message = outcome.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")

    return { message: message || "Done.", isError: outcome.isError === true }
  })

  revalidatePath(`/permissions/${id}`)
  revalidatePath("/tokens", "layout")

  return result
}

/**
 * The owner saves tool levels an assistant proposed, as they left them on
 * /permissions/<id>. This is the only way a proposal is ever written.
 */
export async function saveAccessRequestAction(
  id: string,
  levels: Array<{ serverId: string; tool: string; access: string }>,
): Promise<DecidePermissionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)

  const result = await guarded(async () => {
    const outcome = await applyAccessRequest(ctx, id, levels, { publicUrl })
    const message = outcome.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")

    return { message: message || "Saved.", isError: outcome.isError === true }
  })

  revalidatePath(`/permissions/${id}`)
  revalidatePath("/tokens", "layout")

  return result
}
