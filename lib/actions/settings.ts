"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { revokeAllApiTokens } from "@/lib/core/api-tokens"
import { createDeviceKey, removeDeviceKeys } from "@/lib/core/device-keys"
import { invalid } from "@/lib/core/errors"
import { destroyAllSessions } from "@/lib/core/sessions"
import {
  normalizePublicUrl,
  SETTING_PUBLIC_URL,
  setSetting,
} from "@/lib/core/settings"
import {
  changePassword,
  rotateRecoveryKey,
  validatePassword,
} from "@/lib/core/vault"
import { deleteVault } from "@/lib/core/vault-reset"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import {
  confirmOwner,
  confirmPassword,
  forgiveSessionTry,
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

  // A new password that would be refused is no guess at the current one:
  // say so before a try is spent on it.
  const weak = validatePassword(password)

  if (weak) {
    return { status: "error", error: weak }
  }

  // Checking the current password is a guess like any other.
  if (!withinSessionLimits(session.sessionId)) {
    return { status: "error", error: TOO_MANY_ATTEMPTS }
  }

  return guarded(async () => {
    await changePassword(session.ctx, field(formData, "current"), password)
    forgiveSessionTry(session.sessionId)
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

export type TouchIdResult = ActionState<{ deviceKey: string }>

/**
 * Turns Touch ID on for the Mac app (lib/core/device-keys.ts). The new key
 * comes back once, for the app to keep in the macOS keychain; the page hands
 * it over and forgets it.
 */
export async function enableTouchIdAction(
  _previous: TouchIdResult,
  formData: FormData,
): Promise<TouchIdResult> {
  const session = await requireSession()

  const result = await guarded(async () => {
    // A lasting way in, like a token: the session alone is not enough to
    // make one, and neither is Touch ID.
    await confirmPassword(session, field(formData, "password"))

    return { deviceKey: await createDeviceKey(session.ctx) }
  })

  revalidatePath("/settings")

  return result
}

export async function disableTouchIdAction(): Promise<ActionState> {
  const ctx = await requireContext()
  await removeDeviceKeys(ctx.vaultId)
  revalidatePath("/settings")

  return { status: "ok" }
}

export async function signOutEverywhereAction(
  formData: FormData,
): Promise<void> {
  const ctx = await requireContext()

  if (field(formData, "revokeTokens") === "on") {
    await revokeAllApiTokens(ctx)
  }

  // Touch ID signs in, so it goes with the sessions.
  await removeDeviceKeys(ctx.vaultId)
  await destroyAllSessions(ctx.vaultId)
  await clearSessionCookie()
  redirect("/login")
}

/**
 * Deletes the vault (lib/core/vault-reset.ts) once the box is ticked and the
 * owner has confirmed it is them, with the password or Touch ID: the session
 * alone is not enough, since a session cookie can be copied. Afterwards PCP
 * is not set up; the page has the Mac app forget its Touch ID key and goes
 * to the setup page, which makes the next vault.
 */
export async function deleteVaultAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession()

  // The session row goes with the vault, so the cookie opens nothing after.
  // It is left as it is: changing a cookie re-renders this page, which would
  // send the owner away before the page has had the app forget Touch ID.
  return guarded(async () => {
    if (field(formData, "deleteVault") !== "on") {
      throw invalid("Tick the box to confirm that everything is deleted.")
    }

    await confirmOwner(session, formData)
    await deleteVault(session.ctx)

    return {}
  })
}
