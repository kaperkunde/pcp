"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { NEW_SECRET } from "@/lib/core/constants"
import {
  disconnectGoogle,
  removeGoogle,
  saveGoogleSettings,
  startGoogleConnect,
} from "@/lib/core/google/account"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * The owner's Google page (app/(dashboard)/servers/google): saving their
 * client and the products they want, connecting, disconnecting and removing
 * it. Server Actions run for the signed-in owner only; there is no tool an
 * assistant calls for any of it.
 */

export type GoogleActionResult = ActionState<{ message?: string }>

function refresh() {
  revalidatePath("/servers")
  revalidatePath("/servers/google")
}

/**
 * Saves the client and the chosen products. With `intent` "connect", or when
 * a chosen product still lacks Google's permission, the owner goes on to
 * Google's one consent page, and comes back to PCP's shared callback.
 */
export async function saveGoogleAction(
  _previous: GoogleActionResult,
  formData: FormData,
): Promise<GoogleActionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)
  const intent = field(formData, "intent")
  const picked = field(formData, "authSecretId")
  const next: { url?: string } = {}

  const result = await guarded(async () => {
    const saved = await saveGoogleSettings(
      ctx,
      {
        clientId: field(formData, "clientId"),
        clientSecretId: picked && picked !== NEW_SECRET ? picked : null,
        clientSecretValue:
          picked === NEW_SECRET ? field(formData, "authSecretValue") : null,
        products: formData.getAll("products").map(String),
      },
      { publicUrl },
    )

    if (intent === "connect" || (intent !== "save" && saved.needsConsent)) {
      next.url = (await startGoogleConnect(ctx, { publicUrl })).redirectTo

      return { message: "Opening Google." }
    }

    return {
      message: saved.signedOut
        ? "Saved. You changed the client, so Google is signed out: connect it again."
        : saved.needsConsent
          ? "Saved. Choose Connect to give PCP the permissions the new products need."
          : "Saved.",
    }
  })

  refresh()

  if (next.url) {
    redirect(next.url)
  }

  return result
}

export async function disconnectGoogleAction(
  _previous: GoogleActionResult,
  _formData: FormData,
): Promise<GoogleActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const { revoked } = await disconnectGoogle(ctx)

    return {
      message: revoked
        ? "Disconnected. Google revoked PCP's access."
        : "Disconnected. PCP deleted its tokens; if Google did not answer, remove PCP under your Google account's third-party access too.",
    }
  })

  refresh()

  return result
}

export async function removeGoogleAction(
  _previous: GoogleActionResult,
  _formData: FormData,
): Promise<GoogleActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await removeGoogle(ctx)

    return { message: "Google is removed from PCP." }
  })

  refresh()

  return result
}
