import { createHash } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/server"

import type { VaultContext } from "../context"
import { recordSite, siteCooling } from "../gate"
import { callDeadline, pacedResult, paceSite } from "../pacing"
import { readWebSearchConfig, type WebSearchConfig } from "./config"
import {
  WEB_SEARCH_CACHE_MAX,
  WEB_SEARCH_CACHE_TTL_MS,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
} from "./limits"
import type { Freshness, SearchParams, SearchResult } from "./providers"
import { requestSearch, type PreparedSearch } from "./request"

/**
 * web_search, the part that is not the tool's wording: the owner's provider,
 * a short memory of the last answers, pacing and the gate per provider host
 * (as web fetch's request path has them: a place is a host), and the
 * request. The query and the results are never logged, stored or put in
 * the request log; what is kept for a few minutes is in memory only, under a
 * hash, and holds nothing but what the provider answered.
 *
 * Following a result is web_fetch's job, with its own site rules: a result's
 * address is only text.
 */

export type WebSearchOutcome =
  | {
      type: "results"
      provider: string
      results: SearchResult[]
      cached: boolean
    }
  /** No provider chosen yet: the owner's page sets one up. */
  | { type: "setup" }
  /** Pacing or the gate refused it; nothing was sent. */
  | { type: "paced"; result: CallToolResult }
  /** The provider did not give results. */
  | { type: "failed"; message: string; unauthorized: boolean }

export type SearchInput = {
  query: string
  limit?: number
  region?: string
  language?: string
  freshness?: Freshness
}

/** The call's arguments as a search asks: bounded, codes in lower case. */
export function searchParams(input: SearchInput): SearchParams {
  return {
    query: input.query.trim(),
    limit: Math.min(
      Math.max(1, input.limit ?? WEB_SEARCH_DEFAULT_LIMIT),
      WEB_SEARCH_MAX_LIMIT,
    ),
    ...(input.region ? { region: input.region.toLowerCase() } : {}),
    ...(input.language ? { language: input.language.toLowerCase() } : {}),
    ...(input.freshness ? { freshness: input.freshness } : {}),
  }
}

type Kept = { at: number; provider: string; results: SearchResult[] }

const cache = new Map<string, Kept>()

function cacheKey(
  ctx: VaultContext,
  prepared: PreparedSearch,
  params: SearchParams,
): string {
  return createHash("sha256")
    .update(JSON.stringify([ctx.vaultId, prepared.fingerprint, params]))
    .digest("hex")
}

function remembered(key: string, now: number): Kept | null {
  const kept = cache.get(key)

  if (!kept) {
    return null
  }

  if (now - kept.at > WEB_SEARCH_CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }

  return kept
}

function remember(key: string, kept: Kept): void {
  cache.delete(key)
  cache.set(key, kept)

  // Insertion order is age: the oldest go first.
  for (const old of cache.keys()) {
    if (cache.size <= WEB_SEARCH_CACHE_MAX) {
      break
    }

    cache.delete(old)
  }
}

/** Forgets every kept answer: a changed provider, and tests. */
export function forgetSearches(): void {
  cache.clear()
}

export async function runWebSearch(
  ctx: VaultContext,
  input: SearchInput,
  {
    prepare,
    signal = new AbortController().signal,
    config,
    publicUrl = "",
  }: {
    /** upstream.ts webSearchProvider; the key's header is made there. */
    prepare: (
      ctx: VaultContext,
      config: WebSearchConfig,
      publicUrl?: string,
    ) => Promise<PreparedSearch>
    signal?: AbortSignal
    config?: WebSearchConfig | null
    /** PCP's public address, for the link a service's SSH server needs. */
    publicUrl?: string
  },
): Promise<WebSearchOutcome> {
  const chosen = config === undefined ? await readWebSearchConfig(ctx) : config

  if (!chosen) {
    return { type: "setup" }
  }

  const params = searchParams(input)
  const prepared = await prepare(ctx, chosen, publicUrl)
  const key = cacheKey(ctx, prepared, params)
  const kept = remembered(key, Date.now())

  if (kept) {
    return {
      type: "results",
      provider: kept.provider,
      results: kept.results,
      cached: true,
    }
  }

  // A provider cooling down is not asked at all, and one that is paced
  // waits its turn (lib/core/gate/, lib/core/pacing/), by its host.
  const cooling = siteCooling(ctx, prepared.host)

  if (cooling) {
    return { type: "paced", result: pacedResult(cooling) }
  }

  const paced = await paceSite(ctx, prepared.host, "web_fetch", {
    deadline: callDeadline(),
    signal,
  })

  if (paced) {
    return { type: "paced", result: pacedResult(paced) }
  }

  const started = Date.now()
  let answer: Awaited<ReturnType<typeof requestSearch>>

  try {
    answer = await requestSearch(prepared, params, signal)
  } catch (error) {
    await recordSite(ctx, prepared.host, "web_fetch_site", {
      ok: false,
      ms: Date.now() - started,
    })
    throw error
  }

  const cooled = await recordSite(ctx, prepared.host, "web_fetch_site", {
    ok: answer.kind === "ok",
    ms: Date.now() - started,
    bytes: answer.bytes,
    throttle: answer.kind === "failed" ? answer.throttle : null,
  })

  if (answer.kind === "failed") {
    return {
      type: "failed",
      message: cooled
        ? `${answer.message} PCP lets ${prepared.label} cool down until ${new Date(cooled.until).toISOString()}: web_search refuses it until then.`
        : answer.message,
      unauthorized: answer.unauthorized,
    }
  }

  remember(key, {
    at: Date.now(),
    provider: prepared.label,
    results: answer.results,
  })

  return {
    type: "results",
    provider: prepared.label,
    results: answer.results,
    cached: false,
  }
}
