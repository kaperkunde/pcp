import { createHmac } from "node:crypto"

import type { EmbeddedKinds } from "../constants"
import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString, labelKey } from "../crypto"
import { db } from "../db"
import { newId } from "../ids"
import {
  semanticKey,
  type MemoryCandidate,
  type PcpToolCandidate,
  type SkillCandidate,
  type ToolCandidate,
} from "../search"
import { readEmbeddingsConfig, type EmbeddingsConfig } from "./config"
import {
  EMBED_BATCH_SIZE,
  EMBED_ITEMS_TIMEOUT_MS,
  EMBED_MAX_ITEMS,
  EMBED_MAX_NEW_PER_SEARCH,
  EMBED_MAX_QUERY_CHARS,
  EMBED_MAX_TEXT_CHARS,
  EMBED_QUERY_TIMEOUT_MS,
  EMBED_STALE_MS,
  EMBED_TOUCH_MS,
} from "./limits"
import type { EmbeddingProvider } from "./provider"

/**
 * Search's embeddings: how near each item (a tool, a skill, a memory) is
 * to a query, by the provider the owner chose on Settings, for search.ts to
 * blend with its keyword score. Only what the owner chose to embed is sent
 * (EmbeddedKinds); vectors are cached encrypted per item, found by a keyed
 * hash of the provider and the text, so a changed text is embedded again
 * and the old vector is left for the cleanup. Everything runs inside the
 * search's request, within the bounds in limits.ts: never on a timer, and
 * a provider that fails, is slow or answers nonsense leaves search to its
 * keywords, quietly.
 */

/** One text search may embed, by the key search.ts ranks it under. */
export type EmbedItem = { key: string; text: string }

export type SearchItems = {
  tools: ToolCandidate[]
  pcp?: PcpToolCandidate[]
  skills?: SkillCandidate[]
  memories?: MemoryCandidate[]
}

function cut(text: string, max = EMBED_MAX_TEXT_CHARS): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * The texts search may send the provider, of the kinds the owner chose:
 * a tool's name and description (its title, server/name and description;
 * PCP's own the same), a skill's name and description, a memory's path and
 * text. Nothing else of the vault: no server description, owner's note or
 * argument.
 */
export function itemsToEmbed(
  { tools, pcp = [], skills = [], memories = [] }: SearchItems,
  embed: EmbeddedKinds,
): EmbedItem[] {
  const items: EmbedItem[] = []

  if (embed.tools) {
    for (const tool of tools) {
      items.push({
        key: semanticKey("tool", `${tool.server}/${tool.name}`),
        text: cut(
          `${tool.title ?? tool.name} (${tool.server}/${tool.name}): ${tool.description}`,
        ),
      })
    }

    for (const tool of pcp) {
      items.push({
        key: semanticKey("pcp", tool.name),
        text: cut(`${tool.title} (${tool.name}): ${tool.description}`),
      })
    }
  }

  if (embed.skills) {
    for (const skill of skills) {
      items.push({
        key: semanticKey("skill", `skill:${skill.pathName ?? skill.name}`),
        text: cut(`${skill.name}: ${skill.description}`),
      })
    }
  }

  if (embed.memories) {
    for (const memory of memories) {
      items.push({
        key: semanticKey("memory", memory.path),
        text: cut(`${memory.path}\n${memory.text}`),
      })
    }
  }

  return items.slice(0, EMBED_MAX_ITEMS)
}

const HASH_LABEL = "pcp embedding vector hash v1"

/** The key a vector's hash is made with: the vault's, never stored. */
function hashKey(dek: Buffer): Buffer {
  return labelKey(dek, HASH_LABEL)
}

/** What a vector is found by: the provider and model, and the text. */
export function vectorHash(key: Buffer, fingerprint: string, text: string) {
  return createHmac("sha256", key)
    .update(fingerprint)
    .update("\u0000")
    .update(text)
    .digest("hex")
}

function encodeVector(vector: Float32Array): string {
  return Buffer.from(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  ).toString("base64")
}

function decodeVector(text: string, dimensions: number): Float32Array | null {
  const bytes = Buffer.from(text, "base64")

  if (bytes.byteLength !== dimensions * 4) {
    return null
  }

  const copy = new Uint8Array(bytes)
  return new Float32Array(copy.buffer, 0, dimensions)
}

export function cosine(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length || a.length === 0) {
    return null
  }

  let dot = 0
  let normA = 0
  let normB = 0

  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!
    normA += a[index]! * a[index]!
    normB += b[index]! * b[index]!
  }

  return normA && normB ? dot / Math.sqrt(normA * normB) : null
}

type Cached = { id: string; hash: string; vector: Float32Array }

/** The vectors cached for these hashes, read and decrypted. */
async function readCached(
  ctx: VaultContext,
  hashes: string[],
): Promise<Map<string, Cached & { usedAt: Date }>> {
  const found = new Map<string, Cached & { usedAt: Date }>()

  for (let at = 0; at < hashes.length; at += 500) {
    const rows = await db().embeddingVector.findMany({
      where: { vaultId: ctx.vaultId, hash: { in: hashes.slice(at, at + 500) } },
    })

    for (const row of rows) {
      try {
        const vector = decodeVector(
          decryptString(
            ctx.dek,
            Buffer.from(row.ciphertext),
            `embedding_vector:${row.id}`,
          ),
          row.dimensions,
        )

        if (vector) {
          found.set(row.hash, { ...row, vector })
        }
      } catch {
        // A row that does not decrypt is embedded again.
      }
    }
  }

  return found
}

async function storeVector(
  ctx: VaultContext,
  hash: string,
  vector: Float32Array,
): Promise<void> {
  const id = newId()

  try {
    await db().embeddingVector.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        hash,
        dimensions: vector.length,
        ciphertext: asBytes(
          encryptString(
            ctx.dek,
            encodeVector(vector),
            `embedding_vector:${id}`,
          ),
        ),
      },
    })
  } catch {
    // Another search stored the same text first; its vector serves.
  }
}

/** A signal that aborts at the timeout or with `outer`, whichever first. */
function within(ms: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return outer ? AbortSignal.any([timeout, outer]) : timeout
}

/**
 * The vectors of items not cached yet, the first EMBED_MAX_NEW_PER_SEARCH
 * of them, a batch at a time until the time runs out; each stored as it
 * comes. What is not back in time waits for a later search.
 */
async function embedMissing(
  ctx: VaultContext,
  provider: EmbeddingProvider,
  missing: Array<{ hash: string; text: string }>,
  signal: AbortSignal,
): Promise<Map<string, Float32Array>> {
  const made = new Map<string, Float32Array>()
  const todo = missing.slice(0, EMBED_MAX_NEW_PER_SEARCH)

  for (
    let at = 0;
    at < todo.length && !signal.aborted;
    at += EMBED_BATCH_SIZE
  ) {
    const batch = todo.slice(at, at + EMBED_BATCH_SIZE)

    try {
      const vectors = await provider.embed(
        batch.map((item) => item.text),
        "document",
        signal,
      )

      for (const [position, item] of batch.entries()) {
        made.set(item.hash, vectors[position]!)
        await storeVector(ctx, item.hash, vectors[position]!)
      }
    } catch {
      break
    }
  }

  return made
}

export type SemanticOptions = {
  now?: Date
  queryTimeoutMs?: number
  itemsTimeoutMs?: number
}

/**
 * How near each item is to the query (cosine similarity), by key, for the
 * items that have a vector by the time the query's own came back; null
 * when the query could not be embedded, which leaves search to keywords.
 * Throws nothing.
 */
export async function semanticScores(
  ctx: VaultContext,
  provider: EmbeddingProvider,
  items: EmbedItem[],
  query: string,
  {
    now = new Date(),
    queryTimeoutMs = EMBED_QUERY_TIMEOUT_MS,
    itemsTimeoutMs = EMBED_ITEMS_TIMEOUT_MS,
  }: SemanticOptions = {},
): Promise<Map<string, number> | null> {
  const asked = query.trim().slice(0, EMBED_MAX_QUERY_CHARS)

  if (!asked || items.length === 0) {
    return null
  }

  try {
    const key = hashKey(ctx.dek)
    const hashed = items.map((item) => ({
      ...item,
      hash: vectorHash(key, provider.fingerprint, item.text),
    }))
    const queryVector = provider
      .embed([asked], "query", within(queryTimeoutMs))
      .then(([vector]) => vector ?? null)
      .catch(() => null)
    const cached = await readCached(
      ctx,
      hashed.map((item) => item.hash),
    )
    const seen = new Set<string>()
    const missing = hashed.filter(
      (item) =>
        !cached.has(item.hash) && !seen.has(item.hash) && seen.add(item.hash),
    )
    const made = missing.length
      ? await embedMissing(ctx, provider, missing, within(itemsTimeoutMs))
      : new Map<string, Float32Array>()
    const vector = await queryVector

    if (!vector) {
      return null
    }

    // The vectors used, written as used once a day at most.
    const stale = [...cached.values()]
      .filter((row) => now.getTime() - row.usedAt.getTime() >= EMBED_TOUCH_MS)
      .map((row) => row.id)

    if (stale.length) {
      await db().embeddingVector.updateMany({
        where: { id: { in: stale } },
        data: { usedAt: now },
      })
    }

    const scores = new Map<string, number>()

    for (const item of hashed) {
      const itemVector = cached.get(item.hash)?.vector ?? made.get(item.hash)
      const similarity = itemVector ? cosine(vector, itemVector) : null

      if (similarity !== null) {
        scores.set(item.key, similarity)
      }
    }

    return scores
  } catch (error) {
    console.warn(
      "[search] embeddings left out:",
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

/** Makes the provider for a config: upstream.ts embeddingProvider. */
export type ProviderOpener = (
  ctx: VaultContext,
  config: EmbeddingsConfig,
) => Promise<EmbeddingProvider>

/**
 * Search's similarities for a query, by the vault's provider, or null when
 * it has none or it failed (keywords alone, then).
 */
export async function searchSimilarities(
  ctx: VaultContext,
  items: SearchItems,
  query: string,
  open: ProviderOpener,
  options: SemanticOptions = {},
): Promise<Map<string, number> | null> {
  const config = await readEmbeddingsConfig(ctx.vaultId)

  if (!config) {
    return null
  }

  let provider: EmbeddingProvider

  try {
    provider = await open(ctx, config)
  } catch (error) {
    console.warn(
      "[search] embeddings left out:",
      error instanceof Error ? error.message : String(error),
    )
    return null
  }

  return semanticScores(
    ctx,
    provider,
    itemsToEmbed(items, config.embed),
    query,
    options,
  )
}

/**
 * Vectors no search used for EMBED_STALE_MS (their text changed, the item
 * is gone, the provider is another): a part of the cleanup, by date only.
 */
export async function pruneEmbeddingVectors(now = new Date()): Promise<number> {
  const { count } = await db().embeddingVector.deleteMany({
    where: { usedAt: { lte: new Date(now.getTime() - EMBED_STALE_MS) } },
  })

  return count
}
