"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { destroyAllSessions } from "@/lib/core/sessions"
import {
  normalizePublicUrl,
  SETTING_PUBLIC_URL,
  setSetting,
} from "@/lib/core/settings"
import { changePassword, rotateRecoveryKey } from "@/lib/core/vault"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { clearSessionCookie, requireContext } from "@/lib/server/session"

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
  const ctx = await requireContext()
  const password = field(formData, "password")

  if (password !== field(formData, "confirm")) {
    return { status: "error", error: "The new passwords do not match." }
  }

  return guarded(async () => {
    await changePassword(ctx, field(formData, "current"), password)
    return { message: "Password changed." }
  })
}

export async function rotateRecoveryKeyAction(): Promise<SettingsResult> {
  const ctx = await requireContext()

  return guarded(async () => ({ recoveryKey: await rotateRecoveryKey(ctx) }))
}

export async function signOutEverywhereAction(): Promise<void> {
  const ctx = await requireContext()
  await destroyAllSessions(ctx.vaultId)
  await clearSessionCookie()
  redirect("/login")
}
