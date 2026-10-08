"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { getServer, renameServerSlug } from "@/lib/core/servers"
import {
  createSshServer,
  forgetSshHostKey,
  replaceSshKey,
  updateSshServer,
  type SshServerInput,
} from "@/lib/core/ssh/hosts"
import { syncServerTools } from "@/lib/core/upstream"
import { field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * Adding and editing SSH servers, PCP's key for one and the host key it
 * pinned. Checking, enabling and removing one use the server actions in
 * ./servers: an SSH server is a server to them.
 */

function inputFrom(formData: FormData): SshServerInput {
  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    host: field(formData, "host"),
    port: field(formData, "port") || null,
    username: field(formData, "username"),
  }
}

function revalidate(id: string) {
  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)
  revalidatePath("/tokens/[id]", "page")
}

/** Signs in once, for the message the owner sees after a change. */
async function check(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  id: string,
): Promise<string> {
  const sync = await syncServerTools(ctx, await getServer(ctx, id), {
    publicUrl: await publicUrlFor(ctx),
  })

  return sync.status === "ok" ? "PCP signed in." : sync.message
}

export async function createSshServerAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(() => createSshServer(ctx, inputFrom(formData)))

  if (result.status !== "ok" || !result.id) {
    return result
  }

  // Stores its tool and pins the host key. Signing in fails until the owner
  // adds PCP's key on the server, which the page then says.
  await check(ctx, result.id)

  revalidatePath("/servers")
  redirect(`/servers/${result.id}`)
}

export async function updateSshServerAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    const { reconnect } = await updateSshServer(ctx, id, inputFrom(formData))

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    return {
      message: reconnect ? `Saved. ${await check(ctx, id)}` : "Saved.",
    }
  })

  revalidate(id)
  return result
}

export async function forgetSshHostKeyAction(
  id: string,
): Promise<ServerActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await forgetSshHostKey(ctx, id)
    return {
      message: `Forgotten, and PCP pinned the key the server shows now: check its fingerprint against the server's own. ${await check(ctx, id)}`,
    }
  })

  revalidate(id)
  return result
}

export async function replaceSshKeyAction(
  id: string,
): Promise<ServerActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await replaceSshKey(ctx, id)
    return {
      message:
        "PCP has a new key and has forgotten the old one. Put the new key in authorized_keys on the server in place of the old one.",
    }
  })

  revalidate(id)
  return result
}
