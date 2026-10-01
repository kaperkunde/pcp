"use server"

import { revalidatePath } from "next/cache"

import { createMemory, deleteMemory, updateMemory } from "@/lib/core/memories"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

export type MemoryActionResult = ActionState<{ id?: string; message?: string }>

/** A shared memory the owner writes themselves. */
export async function createMemoryAction(
  _previous: MemoryActionResult,
  formData: FormData,
): Promise<MemoryActionResult> {
  const ctx = await requireContext()

  const result = await guarded(() =>
    createMemory(ctx, {
      path: field(formData, "path"),
      text: field(formData, "text"),
      always: field(formData, "always") === "on",
    }),
  )

  revalidatePath("/memories")

  return result
}

export async function updateMemoryAction(
  _previous: MemoryActionResult,
  formData: FormData,
): Promise<MemoryActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await updateMemory(ctx, field(formData, "id"), {
      path: field(formData, "path"),
      text: field(formData, "text"),
      shared: field(formData, "shared") === "on",
      always: field(formData, "always") === "on",
    })

    return { message: "Saved." }
  })

  revalidatePath("/memories")

  return result
}

export async function deleteMemoryAction(
  id: string,
): Promise<MemoryActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await deleteMemory(ctx, id)
    return {}
  })

  revalidatePath("/memories")

  return result
}
