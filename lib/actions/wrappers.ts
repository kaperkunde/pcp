"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { invalid } from "@/lib/core/errors"
import { renameServerSlug } from "@/lib/core/servers"
import { saveWrapperByOwner, showReplacedTool } from "@/lib/core/wrappers/admin"
import type { WrapperInput } from "@/lib/core/wrappers/definition"
import { field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * The owner's own wrappers: added and changed here, at once. Enabling,
 * removing and the tools' levels use the server actions in ./servers and
 * the token's page: a wrapper is a server to them.
 */

/** The tools field: { tools: [...], secrets: [...] } as JSON. */
function inputFrom(formData: FormData): WrapperInput {
  let parsed: unknown

  try {
    parsed = JSON.parse(field(formData, "definition") || "{}")
  } catch (error) {
    throw invalid(
      `The tools are not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid(
      'The tools are an object: {"tools": [...], "secrets": [...]}.',
    )
  }

  const { tools, secrets } = parsed as Record<string, unknown>

  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    tools: (Array.isArray(tools) ? tools : []) as WrapperInput["tools"],
    secrets: (Array.isArray(secrets) ? secrets : []) as NonNullable<
      WrapperInput["secrets"]
    >,
  }
}

export async function createWrapperAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () =>
    saveWrapperByOwner(ctx, null, inputFrom(formData)),
  )

  if (result.status !== "ok") {
    return result
  }

  revalidatePath("/servers")
  redirect(`/servers/${result.id}`)
}

export async function updateWrapperAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    await saveWrapperByOwner(ctx, id, inputFrom(formData))

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    return { message: "Saved." }
  })

  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)

  return result
}

/** A tool a wrapper stands in for, back in search for every assistant. */
export async function showReplacedToolAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const serverId = field(formData, "serverId")

  const result = await guarded(async () => {
    await showReplacedTool(ctx, serverId, field(formData, "tool"))
    return { message: "It shows in search again." }
  })

  revalidatePath(`/servers/${serverId}`)
  revalidatePath("/servers")

  return result
}
