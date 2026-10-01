"use server"

import { revalidatePath } from "next/cache"

import { notFound } from "@/lib/core/errors"
import { parseDecision } from "@/lib/core/permission-rules"
import { decidePermission, getPermissionView } from "@/lib/core/permissions"
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
  secret?: { name: string; value: string },
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
      {
        via: "web",
        publicUrl,
        // Straight from the browser: only two strings are taken from it.
        ...(typeof secret?.name === "string" && typeof secret.value === "string"
          ? { secret: { name: secret.name, value: secret.value } }
          : {}),
      },
    )
    const message = outcome.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")

    return { message: message || "Done.", isError: outcome.isError === true }
  })

  revalidatePath(`/permissions/${id}`)
  revalidatePath("/tokens", "layout")

  if (secret) {
    revalidatePath("/secrets")
  }

  return result
}
