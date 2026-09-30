"use server"

import { redirect } from "next/navigation"

import { invalid } from "@/lib/core/errors"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { createSession, destroySession } from "@/lib/core/sessions"
import {
  isSetUp,
  resetPasswordWithRecoveryKey,
  setupVault,
  unlockOwnerVault,
} from "@/lib/core/vault"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { clientIp } from "@/lib/server/client-ip"
import {
  clearSessionCookie,
  currentSession,
  writeSessionCookie,
} from "@/lib/server/session"
import { headers } from "next/headers"

/**
 * Setup, sign-in, sign-out and recovery. Each success writes the session
 * cookie here, in the action, which is the one place Next allows it.
 */

const LOGIN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 }
// Per-address limits trust X-Forwarded-For, which a client reaching PCP
// without a proxy can set to anything. This one does not: it caps how many
// password guesses (each a 64 MiB scrypt run) the instance takes at all.
const GLOBAL_LOGIN_LIMIT = { max: 60, windowMs: 15 * 60 * 1000 }

async function withinLoginLimits(scope: string): Promise<boolean> {
  return (
    checkRateLimit(`${scope}:${await clientIp()}`, LOGIN_LIMIT) &&
    checkRateLimit(`${scope}:*`, GLOBAL_LOGIN_LIMIT)
  )
}

async function signIn(ctx: { vaultId: string; dek: Buffer }) {
  const { cookieValue, expiresAt } = await createSession(ctx, {
    userAgent: (await headers()).get("user-agent"),
  })
  await writeSessionCookie(cookieValue, expiresAt)
}

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

export type LoginResult = ActionState

export async function loginAction(
  _previous: LoginResult,
  formData: FormData,
): Promise<LoginResult> {
  if (!(await isSetUp())) {
    redirect("/setup")
  }

  if (!(await withinLoginLimits("login"))) {
    return {
      status: "error",
      error: "Too many attempts. Wait a few minutes and try again.",
    }
  }

  const ctx = await unlockOwnerVault(field(formData, "password"))

  if (!ctx) {
    return { status: "error", error: "That password is not right." }
  }

  await signIn(ctx)
  redirect("/servers")
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
  if (!(await withinLoginLimits("recover"))) {
    return {
      status: "error",
      error: "Too many attempts. Wait a few minutes and try again.",
    }
  }

  const password = field(formData, "password")

  if (password !== field(formData, "confirm")) {
    return { status: "error", error: "The passwords do not match." }
  }

  const result = await guarded(async () => ({
    ctx: await resetPasswordWithRecoveryKey(
      field(formData, "recoveryKey"),
      password,
    ),
  }))

  if (result.status !== "ok") {
    return result
  }

  await signIn(result.ctx)
  redirect("/servers")
}
