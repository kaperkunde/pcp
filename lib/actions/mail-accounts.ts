"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import {
  createMailAccount,
  updateMailAccount,
  type MailAccountInput,
} from "@/lib/core/mail/accounts"
import { getServer, renameServerSlug } from "@/lib/core/servers"
import { syncServerTools } from "@/lib/core/upstream"
import { field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * Adding and editing mail accounts. Checking, enabling, connecting and
 * removing one use the server actions in ./servers: a mail account is a
 * server to them.
 */

function inputFrom(formData: FormData): MailAccountInput {
  const protocol = field(formData, "protocol") === "imap" ? "imap" : "jmap"
  const authType = field(formData, "authType")

  return {
    protocol,
    name: field(formData, "name"),
    description: field(formData, "description"),
    url: field(formData, "url"),
    smtpUrl: field(formData, "smtpUrl") || null,
    readOnly: field(formData, "readOnly") === "on",
    authType:
      authType === "header" || authType === "oauth" ? authType : "basic",
    authUsername: field(formData, "authUsername") || null,
    authSecretId: field(formData, "authSecretId") || null,
    mailFrom: field(formData, "mailFrom") || null,
    oauthClientId: field(formData, "oauthClientId") || null,
    oauthClientSecretId: field(formData, "oauthClientSecretId") || null,
    oauthClientSecretValue: field(formData, "oauthClientSecretValue") || null,
    oauthScope: field(formData, "oauthScope") || null,
    oauthAuthorizeParams: field(formData, "oauthAuthorizeParams") || null,
  }
}

function toolCount(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`
}

export async function createMailAccountAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(() =>
    createMailAccount(ctx, inputFrom(formData)),
  )

  if (result.status !== "ok" || !result.id) {
    return result
  }

  // First contact: sign in now, so the page opens with the tools or with
  // why there are none (an OAuth account waits for Connect).
  const server = await getServer(ctx, result.id)
  await syncServerTools(ctx, server, { publicUrl: await publicUrlFor(ctx) })

  revalidatePath("/servers")
  redirect(`/servers/${result.id}`)
}

export async function updateMailAccountAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    const { reconnect } = await updateMailAccount(ctx, id, inputFrom(formData))

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    if (reconnect) {
      const sync = await syncServerTools(ctx, await getServer(ctx, id), {
        publicUrl: await publicUrlFor(ctx),
      })

      return {
        message:
          sync.status === "ok"
            ? `Saved. Signed in; ${toolCount(sync.toolCount)}.`
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
