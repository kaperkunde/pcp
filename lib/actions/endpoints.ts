"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { MAX_SPEC_BYTES } from "@/lib/core/constants"
import {
  createEndpoint,
  updateEndpoint,
  type EndpointInput,
} from "@/lib/core/endpoints"
import { invalid } from "@/lib/core/errors"
import { renameServerSlug } from "@/lib/core/servers"
import { field, file, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * Adding and editing API endpoints. Refreshing, enabling and removing one
 * use the server actions in ./servers: an endpoint is a server to them.
 */

async function inputFrom(formData: FormData): Promise<EndpointInput> {
  const specSource =
    field(formData, "specSource") === "upload" ? "upload" : "url"
  const authType = field(formData, "authType") === "header" ? "header" : "none"
  let specText: string | null = null

  if (specSource === "upload") {
    const upload = file(formData, "specFile")

    if (upload) {
      // Checked before reading, so an oversized file costs nothing.
      if (upload.size > MAX_SPEC_BYTES) {
        throw invalid(
          `That file is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB.`,
        )
      }

      specText = await upload.text()
    }
  }

  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    baseUrl: field(formData, "baseUrl") || null,
    specSource,
    specUrl: specSource === "url" ? field(formData, "specUrl") : null,
    specText,
    readOnly: field(formData, "readOnly") === "on",
    publicOnly: field(formData, "publicOnly") === "on",
    authType,
    authHeaderName: field(formData, "authHeaderName"),
    authValueTemplate: field(formData, "authValueTemplate"),
    authSecretId: field(formData, "authSecretId") || null,
  }
}

export async function createEndpointAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () =>
    createEndpoint(ctx, await inputFrom(formData)),
  )

  if (result.status !== "ok") {
    return result
  }

  // The schema was read on the way in: the page it opens on shows the
  // tools, or what was left out.
  revalidatePath("/servers")
  redirect(`/servers/${result.id}`)
}

export async function updateEndpointAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    const { sync } = await updateEndpoint(ctx, id, await inputFrom(formData))

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    const tools = `${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}`
    return {
      message: `Saved. ${tools} from the schema.${sync.message ? ` ${sync.message}` : ""}`,
    }
  })

  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)

  return result
}
