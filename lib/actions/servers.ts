"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { canRereadTools } from "@/lib/core/catalogue"
import { disconnectOAuth } from "@/lib/core/oauth"
import {
  createServer,
  deleteServer,
  getServer,
  renameServerSlug,
  setServerEnabled,
  setToolDescription,
  updateServer,
  type AuthType,
  type ServerInput,
} from "@/lib/core/servers"
import { syncServerTools } from "@/lib/core/upstream"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

function inputFrom(formData: FormData): ServerInput {
  const authType = field(formData, "authType") as AuthType

  return {
    name: field(formData, "name"),
    url: field(formData, "url"),
    description: field(formData, "description"),
    authType: ["none", "header", "oauth"].includes(authType)
      ? authType
      : "none",
    authHeaderName: field(formData, "authHeaderName"),
    authValueTemplate: field(formData, "authValueTemplate"),
    authSecretId: field(formData, "authSecretId") || null,
    oauthClientId: field(formData, "oauthClientId") || null,
    oauthClientSecretId: field(formData, "oauthClientSecretId") || null,
    oauthScope: field(formData, "oauthScope") || null,
  }
}

export type ServerActionResult = ActionState<{ id?: string; message?: string }>

function toolCount(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`
}

export async function createServerAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(() => createServer(ctx, inputFrom(formData)))

  if (result.status !== "ok" || !result.id) {
    return result
  }

  // First contact: read the tool list now so the server page opens with
  // it, or with the reason it could not be read.
  const server = await getServer(ctx, result.id)
  await syncServerTools(ctx, server, { publicUrl: await publicUrlFor(ctx) })

  revalidatePath("/servers")
  redirect(`/servers/${result.id}`)
}

export async function updateServerAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    const { reconnect } = await updateServer(ctx, id, inputFrom(formData))

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    // Another address or credential can mean other tools: read them again
    // rather than keep offering the old list.
    if (reconnect) {
      const sync = await syncServerTools(ctx, await getServer(ctx, id), {
        publicUrl: await publicUrlFor(ctx),
      })

      return {
        message:
          sync.status === "ok"
            ? `Saved. Found ${toolCount(sync.toolCount)}.`
            : `Saved. ${sync.message}`,
      }
    }

    return { message: "Saved." }
  })

  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)
  revalidatePath("/tokens/[id]", "page")

  return result
}

export async function refreshToolsAction(
  id: string,
): Promise<ServerActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const server = await getServer(ctx, id)
    const sync = await syncServerTools(ctx, server, {
      publicUrl: await publicUrlFor(ctx),
    })

    return {
      message:
        sync.status === "ok"
          ? `Found ${toolCount(sync.toolCount)}.`
          : sync.message,
    }
  })

  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)
  // Every token's page lists the server's tools.
  revalidatePath("/tokens/[id]", "page")

  return result
}

export async function setToolDescriptionAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const serverId = field(formData, "serverId")

  const result = await guarded(async () => {
    await setToolDescription(
      ctx,
      serverId,
      field(formData, "tool"),
      field(formData, "description") || null,
    )

    return { message: "Saved." }
  })

  revalidatePath(`/servers/${serverId}`)

  return result
}

export async function setServerEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ServerActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setServerEnabled(ctx, id, enabled)

    // A server that was off may have changed meanwhile: an assistant should
    // find what it has now, not what it had then.
    if (enabled) {
      const server = await getServer(ctx, id)

      if (canRereadTools(server)) {
        await syncServerTools(ctx, server, {
          publicUrl: await publicUrlFor(ctx),
        })
      }
    }

    return {}
  })

  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)
  revalidatePath("/tokens/[id]", "page")

  return result
}

export async function disconnectOAuthAction(
  id: string,
): Promise<ServerActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await disconnectOAuth(ctx, id)
    return {
      message: "Disconnected. PCP no longer holds tokens for this server.",
    }
  })

  revalidatePath(`/servers/${id}`)

  return result
}

export async function deleteServerAction(id: string): Promise<void> {
  const ctx = await requireContext()
  await deleteServer(ctx, id)
  revalidatePath("/servers")
  redirect("/servers")
}
