"use server"

import { revalidatePath } from "next/cache"

import {
  finishServiceSignin,
  readServiceSignin,
  startServiceSignin,
} from "@/lib/core/upstream"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * Signing in to the account a service needs, on the owner's own page
 * (app/(dashboard)/servers/[id]/sign-in): reading whether it is signed in,
 * starting a sign-in, and handing the service the code the owner pasted.
 * Each reads the session; lib/core/upstream.ts makes the calls through the
 * service's tunnel. These are the owner's own actions, so no token's levels
 * apply and no request-log line is written. The code is never kept: it goes
 * into the one call to the service, and neither the answer nor an error
 * carries it back.
 */

export type SigninStateResult = ActionState<{
  signedIn: boolean
  who: string | null
}>

export type SigninStartResult = ActionState<{
  url: string
  host: string
  expiresAt: string | null
  /** Its time left as PCP's machine worked it out; null: unknown. */
  msLeft: number | null
}>

export async function signinStatusAction(
  id: string,
): Promise<SigninStateResult> {
  const ctx = await requireContext()

  return guarded(async () =>
    readServiceSignin(ctx, id, { publicUrl: await publicUrlFor(ctx) }),
  )
}

export async function startSigninAction(
  id: string,
): Promise<SigninStartResult> {
  const ctx = await requireContext()

  return guarded(async () =>
    startServiceSignin(ctx, id, { publicUrl: await publicUrlFor(ctx) }),
  )
}

export async function finishSigninAction(
  _previous: SigninStateResult,
  formData: FormData,
): Promise<SigninStateResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")
  const result = await guarded(async () =>
    finishServiceSignin(ctx, id, formData.get("code"), {
      publicUrl: await publicUrlFor(ctx),
    }),
  )

  revalidatePath(`/servers/${id}`)
  return result
}
