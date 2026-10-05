"use server"

import { revalidatePath } from "next/cache"

import {
  addFetchSite,
  removeFetchSite,
  setFetchMethod,
  setFetchPrivate,
  setFetchRuleShared,
  setFetchSite,
  type FetchRuleKind,
} from "@/lib/core/web-fetch"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * What the owner decides about web_fetch on a token's page: a level per
 * method, a level per site, whether private addresses are reached, and
 * whether a line is for all tokens.
 */

export type AddFetchSiteResult = ActionState<{ message: string }>

/**
 * Every token's page: a line for all tokens shows on each, and a token's
 * own line can hide one.
 */
function revalidateTokens() {
  revalidatePath("/tokens")
  revalidatePath("/tokens/[id]", "page")
}

export async function setFetchMethodAction(
  tokenId: string,
  group: string,
  access: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setFetchMethod(ctx, tokenId, group, access)
    return {}
  })

  revalidateTokens()

  return result
}

export async function setFetchPrivateAction(
  tokenId: string,
  access: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setFetchPrivate(ctx, tokenId, access)
    return {}
  })

  revalidateTokens()

  return result
}

export async function setFetchSiteAction(
  tokenId: string,
  site: string,
  level: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setFetchSite(ctx, tokenId, site, level)
    return {}
  })

  revalidateTokens()

  return result
}

export async function setFetchRuleSharedAction(
  tokenId: string,
  kind: FetchRuleKind,
  key: string,
  shared: boolean,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await setFetchRuleShared(ctx, tokenId, kind, key, shared === true)
    return {}
  })

  revalidateTokens()

  return result
}

export async function addFetchSiteAction(
  _previous: AddFetchSiteResult,
  formData: FormData,
): Promise<AddFetchSiteResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const site = await addFetchSite(ctx, field(formData, "tokenId"), {
      site: field(formData, "site"),
      level: field(formData, "level"),
      shared: field(formData, "shared") === "on",
    })

    return { message: `Saved ${site}.` }
  })

  revalidateTokens()

  return result
}

export async function removeFetchSiteAction(
  tokenId: string,
  site: string,
): Promise<ActionState> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await removeFetchSite(ctx, tokenId, site)
    return {}
  })

  revalidateTokens()

  return result
}
