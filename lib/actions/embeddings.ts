"use server"

import { revalidatePath } from "next/cache"

import {
  EMBEDDING_PROVIDERS,
  type EmbeddingProvider,
} from "@/lib/core/constants"
import {
  checkEmbeddingsConfig,
  writeEmbeddingsConfig,
  type EmbeddingsConfig,
} from "@/lib/core/embeddings/config"
import { PcpError, invalid } from "@/lib/core/errors"
import { embeddingProvider } from "@/lib/core/upstream"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * Search's embeddings provider (Settings → Search, lib/core/embeddings/):
 * the vault's own setting. Saving tries the provider once with a word of
 * PCP's own, so a wrong key or address is said here rather than found out
 * by search falling back to keywords.
 */

export type EmbeddingsResult = ActionState<{ message?: string }>

const TRY_TIMEOUT_MS = 15_000

function readConfig(formData: FormData): EmbeddingsConfig {
  const provider = field(formData, "provider") as EmbeddingProvider

  if (!EMBEDDING_PROVIDERS.includes(provider)) {
    throw invalid("Choose a provider.")
  }

  const embed = {
    tools: field(formData, "embedTools") === "on",
    skills: field(formData, "embedSkills") === "on",
    memories: field(formData, "embedMemories") === "on",
  }
  const model = field(formData, "model")
  const secretId = field(formData, "secretId")

  switch (provider) {
    case "voyage":
      if (!secretId) throw invalid("Choose the secret that holds your API key.")
      return { provider, model, secretId, embed }
    case "openai":
      return {
        provider,
        url: field(formData, "url"),
        model,
        secretId: secretId || null,
        embed,
      }
    case "endpoint": {
      const serverId = field(formData, "serverId")
      if (!serverId) throw invalid("Choose the API endpoint.")
      return { provider, serverId, model, embed }
    }
  }
}

export async function saveEmbeddingsAction(
  _previous: EmbeddingsResult,
  formData: FormData,
): Promise<EmbeddingsResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const config = await checkEmbeddingsConfig(ctx, readConfig(formData))
    const provider = await embeddingProvider(
      ctx,
      config,
      await publicUrlFor(ctx),
    )

    try {
      await provider.embed(
        ["PCP search"],
        "query",
        AbortSignal.timeout(TRY_TIMEOUT_MS),
      )
    } catch (error) {
      throw invalid(
        `Not saved: ${error instanceof PcpError ? error.message : "the provider did not answer with a vector."}`,
      )
    }

    await writeEmbeddingsConfig(ctx, config)
    return {
      message:
        "Saved. Search embeds what you chose as assistants search, a little at a time.",
    }
  })

  revalidatePath("/settings")
  return result
}

export async function clearEmbeddingsAction(): Promise<EmbeddingsResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await writeEmbeddingsConfig(ctx, null)
    return { message: "Turned off. Search goes by keywords alone." }
  })

  revalidatePath("/settings")
  return result
}
