"use server"

import { revalidatePath } from "next/cache"

import { PcpError, invalid } from "@/lib/core/errors"
import { webSearchProvider } from "@/lib/core/upstream"
import {
  checkWebSearchConfig,
  writeWebSearchConfig,
  type WebSearchConfig,
} from "@/lib/core/websearch/config"
import {
  isWebSearchProvider,
  PROVIDER_INFO,
} from "@/lib/core/websearch/providers"
import { forgetSearches } from "@/lib/core/websearch/search"
import { requestSearch } from "@/lib/core/websearch/request"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * web_search's provider (Settings → Web search, lib/core/websearch/): the
 * vault's own setting. Saving tries the provider once with a word of PCP's
 * own, so a wrong key or address is said here rather than found out by an
 * assistant.
 */

export type WebSearchResult = ActionState<{ message?: string }>

const TRY_TIMEOUT_MS = 20_000

export async function saveWebSearchAction(
  _previous: WebSearchResult,
  formData: FormData,
): Promise<WebSearchResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const provider = field(formData, "provider")

    if (!isWebSearchProvider(provider)) {
      throw invalid("Choose a provider.")
    }

    const info = PROVIDER_INFO[provider]
    const config: WebSearchConfig = await checkWebSearchConfig(ctx, {
      provider,
      secretId: field(formData, "secretId") || null,
      ...(info.ownAddress
        ? field(formData, "where") === "service"
          ? { service: field(formData, "service") }
          : { url: field(formData, "url") }
        : {}),
    })
    const prepared = await webSearchProvider(
      ctx,
      config,
      await publicUrlFor(ctx),
    )
    const answer = await requestSearch(
      prepared,
      { query: "PCP", limit: 1 },
      AbortSignal.timeout(TRY_TIMEOUT_MS),
    ).catch((error: unknown) => {
      throw invalid(
        `Not saved: ${error instanceof PcpError ? error.message : "the provider did not answer."}`,
      )
    })

    if (answer.kind === "failed") {
      throw invalid(`Not saved: ${answer.message}`)
    }

    await writeWebSearchConfig(ctx, config)
    forgetSearches()
    return {
      message: `Saved. web_search now uses ${prepared.label} for the tokens you ticked "Search the web" for.`,
    }
  })

  revalidatePath("/settings")
  return result
}

export async function clearWebSearchAction(): Promise<WebSearchResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await writeWebSearchConfig(ctx, null)
    forgetSearches()
    return { message: "Turned off. web_search asks for a provider again." }
  })

  revalidatePath("/settings")
  return result
}
