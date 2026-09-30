"use server"

import { revalidatePath } from "next/cache"

import {
  createApiToken,
  deleteApiToken,
  revokeApiToken,
} from "@/lib/core/api-tokens"
import {
  type ActionState,
  field,
  fields,
  guarded,
} from "@/lib/server/action-state"
import { confirmPassword } from "@/lib/server/password-attempts"
import { requireContext, requireSession } from "@/lib/server/session"

export type CreateTokenResult = ActionState<{ token: string; id: string }>

export async function createTokenAction(
  _previous: CreateTokenResult,
  formData: FormData,
): Promise<CreateTokenResult> {
  const session = await requireSession()
  const expiresIn = field(formData, "expiresIn")
  const days = expiresIn ? Number(expiresIn) : 0

  const result = await guarded(async () => {
    // A token is a lasting copy of the vault key: the session alone is not
    // enough to make one.
    await confirmPassword(session, field(formData, "password"))

    return createApiToken(session.ctx, {
      name: field(formData, "name"),
      allowAllServers: field(formData, "access") !== "selected",
      serverIds: fields(formData, "serverIds"),
      expiresAt:
        days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null,
    })
  })

  revalidatePath("/tokens")

  return result
}

export async function revokeTokenAction(id: string): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await revokeApiToken(ctx, id)
    return {}
  })

  revalidatePath("/tokens")

  return result
}

export async function deleteTokenAction(id: string): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await deleteApiToken(ctx, id)
    return {}
  })

  revalidatePath("/tokens")

  return result
}
