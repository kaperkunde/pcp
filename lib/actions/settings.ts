"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { revokeAllApiTokens } from "@/lib/core/api-tokens"
import { destroyAllSessions } from "@/lib/core/sessions"
import {
  normalizePublicUrl,
  SETTING_PUBLIC_URL,
  setSetting,
} from "@/lib/core/settings"
import { changePassword, rotateRecoveryKey } from "@/lib/core/vault"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import {
  confirmPassword,
  TOO_MANY_ATTEMPTS,
  withinSessionLimits,
} from "@/lib/server/password-attempts"
import {
  clearSessionCookie,
  requireContext,
  requireSession,
} from "@/lib/server/session"

export type SettingsResult = ActionState<{
  message?: string
  recoveryKey?: string
}>

export async function setPublicUrlAction(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const url = normalizePublicUrl(field(formData, "publicUrl"))
    await setSetting(ctx, SETTING_PUBLIC_URL, url || null)

    return {
      message: url
        ? `PCP will use ${url} as its public address.`
        : "PCP will use the address each request comes in on.",
    }
  })

  revalidatePath("/settings")

  return result
}

export async function changePasswordAction(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  const session = await requireSession()
  const password = field(formData, "password")

  if (password !== field(formData, "confirm")) {
    return { status: "error", error: "The new passwords do not match." }
  }

  // Checking the current password is a guess like any other.
  if (!withinSessionLimits(session.sessionId)) {
    return { status: "error", error: TOO_MANY_ATTEMPTS }
  }

  return guarded(async () => {
    await changePassword(session.ctx, field(formData, "current"), password)
    return { message: "Password changed." }
  })
}

export async function rotateRecoveryKeyAction(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  const session = await requireSession()

  return guarded(async () => {
    // A recovery key opens the vault without the password: the session
    // alone is not enough to make one.
    await confirmPassword(session, field(formData, "password"))

    return { recoveryKey: await rotateRecoveryKey(session.ctx) }
  })
}

export async function signOutEverywhereAction(
  formData: FormData,
): Promise<void> {
  const ctx = await requireContext()

  if (field(formData, "revokeTokens") === "on") {
    await revokeAllApiTokens(ctx)
  }

  await destroyAllSessions(ctx.vaultId)
  await clearSessionCookie()
  redirect("/login")
}
