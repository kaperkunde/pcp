"use server"

import { revalidatePath } from "next/cache"
import { after } from "next/server"

import {
  bindOrigin,
  endSecretAllowance,
  parseOrigins,
  unbindOrigin,
} from "@/lib/core/browser-secrets"
import {
  createSecret,
  deleteSecret,
  revealSecret,
  revealTotpCode,
  updateSecret,
} from "@/lib/core/secrets"
import { servicesUsingSecret } from "@/lib/core/services/services"
import { restartServicesUsingSecret } from "@/lib/core/upstream"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export type SecretActionResult = ActionState<{ id?: string; message?: string }>

export async function createSecretAction(
  _previous: SecretActionResult,
  formData: FormData,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const kind = field(formData, "kind") === "totp" ? "totp" : "text"
    // Checked before the secret is written, so a mistyped site saves nothing.
    const origins = parseOrigins(field(formData, "origins").split("\n"))
    const created = await createSecret(ctx, {
      name: field(formData, "name"),
      value: field(formData, "value"),
      description: field(formData, "description"),
      kind,
    })

    for (const origin of origins) {
      await bindOrigin(ctx, created.id, origin)
    }

    return created
  })

  revalidatePath("/secrets")

  return result
}

export async function updateSecretAction(
  _previous: SecretActionResult,
  formData: FormData,
): Promise<SecretActionResult> {
  const ctx = await requireContext()
  const value = field(formData, "value")

  const id = field(formData, "id")

  const result = await guarded(async () => {
    await updateSecret(ctx, id, {
      name: field(formData, "name"),
      description: field(formData, "description"),
      ...(value ? { value } : {}),
    })

    if (!value) {
      return {}
    }

    // A service keeps the value it was started with: each one whose
    // variables take this secret is made again with the new one, once this
    // answer is sent, while the request still holds the key.
    const services = await servicesUsingSecret(ctx, id)

    if (services.length === 0) {
      return {}
    }

    const publicUrl = await publicUrlFor(ctx)
    after(() => restartServicesUsingSecret(ctx, id, { publicUrl }))

    return {
      message: `Saved. ${services.length === 1 ? "The service that uses it is" : `The ${services.length} services that use it are`} being restarted with the new value; their pages show how that went.`,
    }
  })

  revalidatePath("/secrets")
  revalidatePath("/servers")

  return result
}

export async function deleteSecretAction(
  id: string,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await deleteSecret(ctx, id)
    return {}
  })

  revalidatePath("/secrets")

  return result
}

/** A TOTP secret's code of the moment, on the owner's own screen. */
export async function revealTotpCodeAction(
  id: string,
): Promise<ActionState<{ code: string; secondsLeft: number }>> {
  const ctx = await requireContext()

  return guarded(async () => {
    const { code, secondsLeft } = await revealTotpCode(ctx, id)
    return { code, secondsLeft }
  })
}

/** Adds a site where the browser may type the secret. */
export async function addSecretOriginAction(
  _previous: SecretActionResult,
  formData: FormData,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await bindOrigin(ctx, field(formData, "id"), field(formData, "origin"))
    return {}
  })

  revalidatePath("/secrets")

  return result
}

/**
 * Takes a site away from the secret, and every token's allowance to have
 * it typed there.
 */
export async function removeSecretOriginAction(
  id: string,
  origin: string,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await unbindOrigin(ctx, String(id), String(origin))
    return {}
  })

  revalidatePath("/secrets")
  revalidatePath("/tokens", "layout")

  return result
}

/** Ends one token's allowance to have the secret typed at a site. */
export async function endSecretAllowanceAction(
  tokenId: string,
  secretId: string,
  origin: string,
): Promise<SecretActionResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await endSecretAllowance(ctx, {
      tokenId: String(tokenId),
      secretId: String(secretId),
      origin: String(origin),
    })
    return {}
  })

  revalidatePath("/secrets")
  revalidatePath(`/tokens/${tokenId}`)

  return result
}

export async function revealSecretAction(
  id: string,
): Promise<ActionState<{ value: string }>> {
  const ctx = await requireContext()

  return guarded(async () => ({ value: await revealSecret(ctx, id) }))
}
