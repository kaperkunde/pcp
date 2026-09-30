"use server"

import { revalidatePath } from "next/cache"

import {
  createSecret,
  deleteSecret,
  revealSecret,
  updateSecret,
} from "@/lib/core/secrets"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

export type SecretActionResult = ActionState<{ id?: string }>

export async function createSecretAction(
  _previous: SecretActionResult,
  formData: FormData,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(() =>
    createSecret(ctx, {
      name: field(formData, "name"),
      value: field(formData, "value"),
      description: field(formData, "description"),
    }),
  )

  revalidatePath("/secrets")

  return result
}

export async function updateSecretAction(
  _previous: SecretActionResult,
  formData: FormData,
): Promise<SecretActionResult> {
  const ctx = await requireContext()
  const value = field(formData, "value")

  const result = await guarded(async () => {
    await updateSecret(ctx, field(formData, "id"), {
      name: field(formData, "name"),
      description: field(formData, "description"),
      ...(value ? { value } : {}),
    })

    return {}
  })

  revalidatePath("/secrets")

  return result
}

export async function deleteSecretAction(
  id: string,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await deleteSecret(ctx, id)
    return {}
  })

  revalidatePath("/secrets")

  return result
}

export async function revealSecretAction(
  id: string,
): Promise<ActionState<{ value: string }>> {
  const ctx = await requireContext()

  return guarded(async () => ({ value: await revealSecret(ctx, id) }))
}
