"use server"

import { revalidatePath } from "next/cache"

import {
  createMemory,
  deleteMemories,
  deleteMemory,
  setMemoriesAccess,
  updateMemory,
} from "@/lib/core/memories"
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

/** Several memories at once, from the page's selection. */
export async function deleteMemoriesAction(
  ids: string[],
): Promise<MemoryActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const { deleted } = await deleteMemories(ctx, ids)

    return { message: `Deleted ${count(deleted)}.` }
  })

  revalidatePath("/memories")

  return result
}

/**
 * Several memories at once to all tokens (`"all"`) or to one token (its id):
 * who reads them is all that changes.
 */
export async function setMemoriesAccessAction(
  ids: string[],
  access: string,
): Promise<MemoryActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const { changed, unchanged, unmarked } = await setMemoriesAccess(
      ctx,
      ids,
      access === "all" ? { to: "all" } : { to: "token", tokenId: access },
    )

    return {
      message: [
        changed > 0
          ? `Changed who reads ${count(changed)}.`
          : "Nothing to change: they are there already.",
        ...(changed > 0 && unchanged > 0
          ? [`${count(unchanged)} already there.`]
          : []),
        ...(unmarked > 0
          ? [
              `${count(unmarked)} no longer ${unmarked === 1 ? "is" : "are"} read in every conversation: tick that again on ${unmarked === 1 ? "it" : "each"} if you still want it.`,
            ]
          : []),
      ].join(" "),
    }
  })

  revalidatePath("/memories")

  return result
}

function count(number: number): string {
  return `${number} ${number === 1 ? "memory" : "memories"}`
}
