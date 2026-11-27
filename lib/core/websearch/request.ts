import { describeFetchError, discard, readCapped } from "../openapi/http"
import { makeRedactor } from "../openapi/redact"
import { send, type SendOptions } from "../openapi/transport"
import { httpSignal, type Throttle } from "../throttle-signal"
import { WEB_SEARCH_MAX_RESPONSE_BYTES, WEB_SEARCH_TIMEOUT_MS } from "./limits"
import {
  buildRequest,
  PROVIDER_INFO,
  readResults,
  type SearchParams,
  type SearchResult,
  type WebSearchProvider,
} from "./providers"

/**
 * One search request: the provider's HTTP call, given its finished header
 * by upstream.ts (webSearchProvider), which is where the secret is read.
 * This never reads a secret, follows no redirect, reads a bounded answer,
 * and scrubs the credential from whatever it says back.
 */

/** A provider ready to be asked: built by upstream.ts, faked in tests. */
export type PreparedSearch = {
  provider: WebSearchProvider
  /** Its host, the place pacing and the gate keep. */
  host: string
  /** What an error calls it. */
  label: string
  /** The provider and address: part of the cache key. */
  fingerprint: string
  /** A search the owner runs: its address. */
  base?: string
  /** The key as a header's value (prefix included); none for no key. */
  key: string | null
  /** The credential's values, to keep out of an error. */
  redact: string[]
  /** Which addresses it may reach (public only, PCP's own never). */
  sendOptions: SendOptions
}

export type SearchAnswer =
  | { kind: "ok"; results: SearchResult[]; bytes: number }
  | {
      kind: "failed"
      message: string
      /** The provider asked PCP to slow down (the gate's signal). */
      throttle: Throttle | null
      bytes: number
      /** The key was refused: the owner has to look at the setting. */
      unauthorized: boolean
    }

export async function requestSearch(
  prepared: PreparedSearch,
  params: SearchParams,
  signal: AbortSignal,
): Promise<SearchAnswer> {
  const scrub = makeRedactor(prepared.redact)
  const request = buildRequest(prepared.provider, params, {
    ...(prepared.base ? { base: prepared.base } : {}),
  })
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(request.body ? { "Content-Type": "application/json" } : {}),
    ...(prepared.key ? { [request.auth.header]: prepared.key } : {}),
  }
  const failed = (
    message: string,
    extra: Partial<Extract<SearchAnswer, { kind: "failed" }>> = {},
  ): SearchAnswer => ({
    kind: "failed",
    message,
    throttle: null,
    bytes: 0,
    unauthorized: false,
    ...extra,
  })
  const timeout = AbortSignal.any([
    signal,
    AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
  ])
  let response: Response

  try {
    response = await send(
      request.url,
      {
        method: request.method,
        headers,
        ...(request.body ? { body: request.body } : {}),
        signal: timeout,
      },
      prepared.sendOptions,
    )
  } catch (error) {
    if (signal.aborted) {
      throw error
    }

    return failed(
      `${prepared.label} could not be reached: ${scrub.text(describeFetchError(error, WEB_SEARCH_TIMEOUT_MS))}`,
    )
  }

  const throttle = httpSignal(response.status, response.headers, prepared.host)

  if (response.status < 200 || response.status >= 300) {
    await discard(response)

    return failed(
      response.status === 401 || response.status === 403
        ? `${prepared.label} refused the API key (HTTP ${response.status}). The owner can choose another on Settings → Web search.`
        : response.status === 429
          ? `${prepared.label} says there have been too many searches (HTTP 429), or the plan's allowance is spent.`
          : `${prepared.label} answered HTTP ${response.status}.`,
      {
        throttle,
        unauthorized: response.status === 401 || response.status === 403,
      },
    )
  }

  let bytes: Buffer
  let truncated: boolean

  try {
    ;({ bytes, truncated } = await readCapped(
      response,
      WEB_SEARCH_MAX_RESPONSE_BYTES,
    ))
  } catch (error) {
    if (signal.aborted) {
      throw error
    }

    return failed(
      `${prepared.label}'s answer could not be read: ${scrub.text(describeFetchError(error, WEB_SEARCH_TIMEOUT_MS))}`,
    )
  }

  if (truncated) {
    return failed(`${prepared.label}'s answer is too long.`, {
      bytes: bytes.length,
    })
  }

  let body: unknown

  try {
    body = JSON.parse(bytes.toString("utf8"))
  } catch {
    return failed(
      `${prepared.label} did not answer JSON${PROVIDER_INFO[prepared.provider].ownAddress ? " (is format=json switched on in its settings?)" : ""}.`,
      { bytes: bytes.length },
    )
  }

  const results = readResults(prepared.provider, body, params.limit)

  if (!results) {
    return failed(`${prepared.label} did not answer with search results.`, {
      bytes: bytes.length,
    })
  }

  return {
    kind: "ok",
    results: scrub.value(results) as SearchResult[],
    bytes: bytes.length,
  }
}
