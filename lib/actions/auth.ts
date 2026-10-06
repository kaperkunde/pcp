"use server"

import { redirect } from "next/navigation"

import { TOUCH_ID_REJECTED } from "@/lib/core/constants"
import {
  createDeviceKey,
  removeDeviceKeys,
  unlockWithDeviceKey,
} from "@/lib/core/device-keys"
import { invalid } from "@/lib/core/errors"
import { destroySession } from "@/lib/core/sessions"
import {
  isSetUp,
  resetPasswordWithRecoveryKey,
  setupVault,
  unlockOwnerVault,
} from "@/lib/core/vault"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import {
  TOO_MANY_ATTEMPTS,
  forgiveSignInTry,
  withinSignInLimits,
} from "@/lib/server/password-attempts"
import { returnPath } from "@/lib/server/return-path"
import {
  clearSessionCookie,
  currentSession,
  signIn,
} from "@/lib/server/session"

/**
 * Setup, sign-in, sign-out and recovery. Each success writes the session
 * cookie here, in the action, which is the one place Next allows it.
 */

export type SetupResult = ActionState<{ recoveryKey: string }>

export async function setupAction(
  _previous: SetupResult,
  formData: FormData,
): Promise<SetupResult> {
  return guarded(async () => {
    const password = field(formData, "password")

    if (password !== field(formData, "confirm")) {
      throw invalid("The passwords do not match.")
    }

    const { vaultId, dek, recoveryKey } = await setupVault({
      name: field(formData, "name"),
      password,
    })
    await signIn({ vaultId, dek })

    return { recoveryKey }
  })
}

/**
 * With `touchId` ticked (the Mac app, where Touch ID is available), the
 * password turns Touch ID on instead of signing in: the new key comes back
 * once, the app keeps it, and the page signs in with it
 * (`touchIdLoginAction`). Signing in here would send the page on to the
 * servers before the app had the key.
 */
export type LoginResult = ActionState<{ deviceKey?: string }>

export async function loginAction(
  _previous: LoginResult,
  formData: FormData,
): Promise<LoginResult> {
  if (!(await isSetUp())) {
    redirect("/setup")
  }

  if (!(await withinSignInLimits("password"))) {
    return { status: "error", error: TOO_MANY_ATTEMPTS }
  }

  const ctx = await unlockOwnerVault(field(formData, "password"))

  if (!ctx) {
    return { status: "error", error: "That password is not right." }
  }

  await forgiveSignInTry("password")

  if (field(formData, "touchId") === "on") {
    return { status: "ok", deviceKey: await createDeviceKey(ctx) }
  }

  await signIn(ctx)
  redirect(returnPath(field(formData, "next")) ?? "/servers")
}

export type TouchIdLoginResult = ActionState

/**
 * Unlocks with the key the Mac app hands over after Touch ID. With `once`,
 * a key just made that the app did not keep: it signs in this once, and is
 * gone after.
 */
export async function touchIdLoginAction(
  _previous: TouchIdLoginResult,
  formData: FormData,
): Promise<TouchIdLoginResult> {
  if (!(await isSetUp())) {
    redirect("/setup")
  }

  if (!(await withinSignInLimits("touch-id"))) {
    return { status: "error", error: TOO_MANY_ATTEMPTS }
  }

  const ctx = await unlockWithDeviceKey(field(formData, "deviceKey"))

  if (!ctx) {
    return { status: "error", error: TOUCH_ID_REJECTED }
  }

  await forgiveSignInTry("touch-id")

  if (field(formData, "once") === "on") {
    await removeDeviceKeys(ctx.vaultId)
  }

  await signIn(ctx)
  redirect(returnPath(field(formData, "next")) ?? "/servers")
}

export async function logoutAction(): Promise<void> {
  const session = await currentSession()

  if (session) {
    await destroySession(session.sessionId)
  }

  await clearSessionCookie()
  redirect("/login")
}

export type RecoverResult = ActionState

export async function recoverAction(
  _previous: RecoverResult,
  formData: FormData,
): Promise<RecoverResult> {
  if (!(await withinSignInLimits("recovery-key"))) {
    return { status: "error", error: TOO_MANY_ATTEMPTS }
  }

  const password = field(formData, "password")

  if (password !== field(formData, "confirm")) {
    return { status: "error", error: "The passwords do not match." }
  }

  const result = await guarded(async () => ({
    ctx: await resetPasswordWithRecoveryKey(
      field(formData, "recoveryKey"),
      password,
      { revokeApiTokens: field(formData, "revokeTokens") === "on" },
    ),
  }))

  if (result.status !== "ok") {
    return result
  }

  await signIn(result.ctx)
  redirect("/servers")
}
