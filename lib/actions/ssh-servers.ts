"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { getServer, renameServerSlug } from "@/lib/core/servers"
import {
  createSshServer,
  replaceSshKey,
  setSshCertificate,
  updateSshServer,
  type SshServerInput,
} from "@/lib/core/ssh/hosts"
import { syncServerTools } from "@/lib/core/upstream"
import { field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * Adding and editing SSH servers, and giving PCP its certificate. Checking,
 * enabling and removing one use the server actions in ./servers: an SSH
 * server is a server to them.
 */

function inputFrom(formData: FormData): SshServerInput {
  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    host: field(formData, "host"),
    port: field(formData, "port") || null,
    username: field(formData, "username"),
    hostCas: field(formData, "hostCas"),
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

  // Stores its tool; there is no certificate yet, so the page opens with
  // PCP's key to sign.
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

export async function setSshCertificateAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    await setSshCertificate(ctx, id, field(formData, "certificate"))
    return { message: `Certificate saved. ${await check(ctx, id)}` }
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
        "PCP has a new key and has forgotten the old one. Sign the new key with your user CA and paste its certificate. If the old key may have been copied, revoke its certificate on the server (RevokedKeys).",
    }
  })

  revalidate(id)
  return result
}
