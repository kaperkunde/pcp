import { z } from "zod"

import {
  EMBEDDING_PROVIDERS,
  type EmbeddedKinds,
  type EmbeddingProvider,
} from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid } from "../errors"
import { getVaultSetting, setSetting } from "../settings"
import { EMBED_MAX_MODEL_CHARS, EMBED_MAX_URL_CHARS } from "./limits"

/**
 * The owner's embeddings provider for search (Settings → Search), kept as
 * the vault's setting SETTING_EMBEDDINGS: it names the owner's secret and
 * servers, so it is the vault's, never the machine's. None set is keyword
 * search alone. It holds no secret: a secret by its id, a server by its id;
 * upstream.ts reads the secret when a request embeds something.
 */

export const SETTING_EMBEDDINGS = "embeddings"

export type EmbeddingsConfig =
  | {
      provider: "voyage"
      model: string
      /** A text secret: the API key. */
      secretId: string
      embed: EmbeddedKinds
    }
  | {
      provider: "openai"
      /** Its base address, or the /embeddings address itself. */
      url: string
      model: string
      /** A text secret sent as a bearer token, when it takes one. */
      secretId: string | null
      embed: EmbeddedKinds
    }
  | {
      provider: "endpoint"
      /**
       * An API endpoint (a server of kind openapi), as a service registers
       * one: its address, credential and public-only rule are used.
       */
      serverId: string
      /** Left empty for a server that has one model (text-embeddings-inference). */
      model: string
      embed: EmbeddedKinds
    }

const Embed = z.strictObject({
  tools: z.boolean(),
  skills: z.boolean(),
  memories: z.boolean(),
})
const Model = z.string().max(EMBED_MAX_MODEL_CHARS)
const Id = z.string().min(1).max(100)

const ConfigSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("voyage"),
    model: Model.min(1),
    secretId: Id,
    embed: Embed,
  }),
  z.strictObject({
    provider: z.literal("openai"),
    url: z.string().min(1).max(EMBED_MAX_URL_CHARS),
    model: Model.min(1),
    secretId: Id.nullable(),
    embed: Embed,
  }),
  z.strictObject({
    provider: z.literal("endpoint"),
    serverId: Id,
    model: Model,
    embed: Embed,
  }),
])

/**
 * The vault's provider, or null for none. A value that does not read as
 * one (a hand-edited export) counts as none: search keeps to keywords.
 */
export async function readEmbeddingsConfig(
  vaultId: string,
): Promise<EmbeddingsConfig | null> {
  const raw = await getVaultSetting(vaultId, SETTING_EMBEDDINGS)

  if (!raw) {
    return null
  }

  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The /embeddings address an OpenAI-compatible base address stands for. */
export function embeddingsUrl(base: string): string {
  const url = new URL(base)
  const path = url.pathname.replace(/\/+$/, "")

  url.pathname = path.endsWith("/embeddings")
    ? path
    : path.endsWith("/v1")
      ? `${path}/embeddings`
      : `${path}/v1/embeddings`
  url.search = ""
  url.hash = ""
  return url.toString()
}

/** An address the owner typed, as http(s) with no credentials in it. */
export function checkEmbeddingsUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    throw invalid(
      "Enter the provider's full address, like https://api.example.com/v1.",
    )
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("The address must start with http:// or https://.")
  }

  if (url.username || url.password) {
    throw invalid(
      "Leave the user name and password out of the address: choose a secret instead.",
    )
  }

  if (trimmed.length > EMBED_MAX_URL_CHARS) {
    throw invalid(`Keep the address under ${EMBED_MAX_URL_CHARS} characters.`)
  }

  return trimmed.replace(/\/+$/, "")
}

/**
 * A provider as the owner set it on Settings, checked: a text secret of
 * the vault, an API endpoint of the vault, an http(s) address. Throws a
 * message for the owner.
 */
export async function checkEmbeddingsConfig(
  ctx: VaultContext,
  input: EmbeddingsConfig,
): Promise<EmbeddingsConfig> {
  if (!EMBEDDING_PROVIDERS.includes(input.provider as EmbeddingProvider)) {
    throw invalid("Choose a provider.")
  }

  const model = input.model.trim()

  if (model.length > EMBED_MAX_MODEL_CHARS) {
    throw invalid(`Keep the model under ${EMBED_MAX_MODEL_CHARS} characters.`)
  }

  if (!input.embed.tools && !input.embed.skills && !input.embed.memories) {
    throw invalid("Choose at least one thing to embed.")
  }

  const textSecret = async (id: string, what: string) => {
    const row = await db().secret.findFirst({
      where: { id, vaultId: ctx.vaultId },
      select: { kind: true },
    })

    if (row?.kind !== "text") {
      throw invalid(`Choose ${what} from your secrets.`)
    }
  }

  switch (input.provider) {
    case "voyage":
      if (!model) throw invalid("Enter the model, like voyage-3.5-lite.")
      await textSecret(input.secretId, "the Voyage AI API key")
      return { ...input, model }
    case "openai": {
      if (!model) throw invalid("Enter the model the address serves.")
      if (input.secretId) await textSecret(input.secretId, "the API key")
      const url = checkEmbeddingsUrl(input.url)
      embeddingsUrl(url)
      return { ...input, url, model }
    }
    case "endpoint": {
      const server = await db().mcpServer.findFirst({
        where: { id: input.serverId, vaultId: ctx.vaultId },
        select: { kind: true },
      })

      if (server?.kind !== "openapi") {
        throw invalid("Choose one of your API endpoints.")
      }

      return { ...input, model }
    }
  }
}

/**
 * Writes the provider (null for none). Every cached vector goes with the
 * old one: a vector is the provider's and the model's own, and what the
 * owner chose to embed may be less than before.
 */
export async function writeEmbeddingsConfig(
  ctx: VaultContext,
  config: EmbeddingsConfig | null,
): Promise<void> {
  await setSetting(
    ctx,
    SETTING_EMBEDDINGS,
    config ? JSON.stringify(ConfigSchema.parse(config)) : null,
  )
  await db().embeddingVector.deleteMany({ where: { vaultId: ctx.vaultId } })
}

/** What Settings shows of the provider: nothing secret, names by id. */
export type EmbeddingsOverview = {
  config: EmbeddingsConfig | null
  /** The vault's text secrets, to choose an API key from. */
  secrets: Array<{ id: string; name: string }>
  /** The vault's API endpoints, to choose a service's from. */
  endpoints: Array<{ id: string; name: string; service: boolean }>
  /** Vectors cached now. */
  vectors: number
}

export async function embeddingsOverview(
  ctx: VaultContext,
): Promise<EmbeddingsOverview> {
  const [config, secrets, endpoints, registered, vectors] = await Promise.all([
    readEmbeddingsConfig(ctx.vaultId),
    db().secret.findMany({
      where: { vaultId: ctx.vaultId, kind: "text" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId, kind: "openapi" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db().serviceSpec.findMany({
      where: { server: { vaultId: ctx.vaultId }, registeredId: { not: null } },
      select: { registeredId: true },
    }),
    db().embeddingVector.count({ where: { vaultId: ctx.vaultId } }),
  ])
  const byService = new Set(registered.map((row) => row.registeredId))

  return {
    config,
    secrets,
    endpoints: endpoints.map((row) => ({
      ...row,
      service: byService.has(row.id),
    })),
    vectors,
  }
}
