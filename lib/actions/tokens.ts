"use server"

import { revalidatePath } from "next/cache"

import {
  createApiToken,
  deleteApiToken,
  revokeApiToken,
  updateApiToken,
} from "@/lib/core/api-tokens"
import {
  copyTokenAccess,
  parseToolAccess,
  setServerToolAccess,
  setToolAccess,
  setToolAccessShared,
} from "@/lib/core/tool-access"
import {
  type ActionState,
  field,
  fields,
  guarded,
} from "@/lib/server/action-state"
import { confirmPassword } from "@/lib/server/password-attempts"
import { requireContext, requireSession } from "@/lib/server/session"

export type CreateTokenResult = ActionState<{ token: string; id: string }>

export type UpdateTokenResult = ActionState<{ message: string }>

const DAY_MS = 24 * 60 * 60 * 1000

function revalidateToken(id: string) {
  revalidatePath("/tokens")
  revalidatePath(`/tokens/${id}`)
}

/** A level for all tokens shows on every token's page. */
function revalidateEveryToken() {
  revalidatePath("/tokens")
  revalidatePath("/tokens/[id]", "page")
}

export async function createTokenAction(
  _previous: CreateTokenResult,
  formData: FormData,
): Promise<CreateTokenResult> {
  const session = await requireSession()
  const expiresIn = field(formData, "expiresIn")
  const days = expiresIn ? Number(expiresIn) : 0

  const result = await guarded(async () => {
    // A token is a lasting copy of the vault key: the session alone is not
    // enough to make one.
    await confirmPassword(session, field(formData, "password"))

    return createApiToken(session.ctx, {
      name: field(formData, "name"),
      allowAllServers: field(formData, "access") !== "selected",
      serverIds: fields(formData, "serverIds"),
      manageEndpoints: field(formData, "manageEndpoints") === "on",
      keepMemories: field(formData, "keepMemories") === "on",
      webFetch: field(formData, "webFetch") === "on",
      expiresAt:
        days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null,
    })
  })

  revalidatePath("/tokens")

  return result
}

export async function revokeTokenAction(id: string): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await revokeApiToken(ctx, id)
    return {}
  })

  revalidatePath("/tokens")

  return result
}

export async function deleteTokenAction(id: string): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await deleteApiToken(ctx, id)
    return {}
  })

  revalidatePath("/tokens")

  return result
}

/** Name, servers, how PCP asks and expiry of an existing token. */
export async function updateTokenAction(
  _previous: UpdateTokenResult,
  formData: FormData,
): Promise<UpdateTokenResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")
  const expiresIn = field(formData, "expiresIn")
  const days = Number(expiresIn)

  const result = await guarded(async () => {
    await updateApiToken(ctx, id, {
      name: field(formData, "name"),
      allowAllServers: field(formData, "access") !== "selected",
      serverIds: fields(formData, "serverIds"),
      manageEndpoints: field(formData, "manageEndpoints") === "on",
      keepMemories: field(formData, "keepMemories") === "on",
      webFetch: field(formData, "webFetch") === "on",
      expiresAt:
        expiresIn === "keep"
          ? undefined
          : days > 0
            ? new Date(Date.now() + days * DAY_MS)
            : null,
    })

    return { message: "Saved." }
  })

  revalidateToken(id)

  return result
}

export async function setToolAccessAction(
  tokenId: string,
  serverId: string,
  toolName: string,
  access: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setToolAccess(
      ctx,
      tokenId,
      serverId,
      toolName,
      parseToolAccess(access),
    )
    return {}
  })

  revalidateToken(tokenId)

  return result
}

/** The "All tokens" box on a tool's row. */
export async function setToolAccessSharedAction(
  tokenId: string,
  serverId: string,
  toolName: string,
  shared: boolean,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setToolAccessShared(ctx, tokenId, serverId, toolName, shared === true)
    return {}
  })

  revalidateEveryToken()

  return result
}

export async function setServerToolAccessAction(
  tokenId: string,
  serverId: string,
  access: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setServerToolAccess(ctx, tokenId, serverId, parseToolAccess(access))
    return {}
  })

  revalidateToken(tokenId)

  return result
}

export async function copyTokenAccessAction(
  tokenId: string,
  sourceTokenId: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await copyTokenAccess(ctx, tokenId, sourceTokenId)
    return {}
  })

  revalidateToken(tokenId)

  return result
}
