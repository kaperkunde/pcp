import { PcpError } from "../errors"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { makeRedactor } from "../openapi/redact"
import { send, type SendOptions } from "../openapi/transport"
import { EMBED_MAX_DIMENSIONS, EMBED_MAX_RESPONSE_BYTES } from "./limits"

/**
 * One embeddings request: the provider's HTTP call, given its finished
 * headers by upstream.ts (embeddingProvider), which is where the secret is
 * read. This never reads a secret, follows no redirect, reads a bounded
 * answer, and scrubs the credential from whatever it says back.
 */

/** What a text is embedded as: Voyage AI embeds a query and a document apart. */
export type EmbedInput = "query" | "document"

/** A provider search can use: built by upstream.ts, faked in tests. */
export type EmbeddingProvider = {
  /**
   * The provider, address and model: part of every cached vector's hash,
   * so another provider's vectors are never compared with this one's.
   */
  fingerprint: string
  embed(
    texts: string[],
    input: EmbedInput,
    signal: AbortSignal,
  ): Promise<Float32Array[]>
}

export type EmbeddingsRequest = {
  /** The /embeddings address. */
  url: string
  /** Voyage AI's body (input_type), or OpenAI's. */
  style: "voyage" | "openai"
  /** Left out of the body when empty. */
  model: string
  headers: Record<string, string>
  /** The credential's values, to keep out of an error. */
  redact: string[]
  /** Which addresses it may reach (public only, PCP's own never). */
  sendOptions: SendOptions
}

export async function requestEmbeddings(
  request: EmbeddingsRequest,
  texts: string[],
  input: EmbedInput,
  signal: AbortSignal,
): Promise<Float32Array[]> {
  const scrub = makeRedactor(request.redact)
  const body = JSON.stringify({
    input: texts,
    ...(request.model ? { model: request.model } : {}),
    ...(request.style === "voyage" ? { input_type: input } : {}),
  })
  let response: Response

  try {
    response = await send(
      request.url,
      {
        method: "POST",
        headers: {
          ...request.headers,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal,
      },
      request.sendOptions,
    )
  } catch (error) {
    throw new PcpError(
      "upstream",
      `The embeddings provider could not be reached: ${scrub.text(describeFetchError(error, 0))}`,
    )
  }

  if (response.status < 200 || response.status >= 300) {
    await discard(response)
    throw new PcpError(
      "upstream",
      `The embeddings provider answered HTTP ${response.status}.`,
    )
  }

  const { bytes, truncated } = await readCapped(
    response,
    EMBED_MAX_RESPONSE_BYTES,
  )

  if (truncated) {
    throw new PcpError(
      "upstream",
      "The embeddings provider's answer is too long.",
    )
  }

  return readVectors(bytes.toString("utf8"), texts.length)
}

/**
 * The vectors in an OpenAI-shaped answer ({data: [{embedding, index}]},
 * which Voyage AI and text-embeddings-inference also give), in the order
 * of the texts, each checked: as many as were asked for, numbers only,
 * one length for all.
 */
export function readVectors(text: string, count: number): Float32Array[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PcpError(
      "upstream",
      "The embeddings provider's answer is not JSON.",
    )
  }

  const data = (parsed as { data?: unknown })?.data

  if (!Array.isArray(data) || data.length !== count) {
    throw new PcpError(
      "upstream",
      "The embeddings provider did not answer one vector per text.",
    )
  }

  const vectors: Float32Array[] = new Array(count)
  let dimensions = 0

  data.forEach((entry: unknown, position) => {
    const { embedding, index = position } = (entry ?? {}) as {
      embedding?: unknown
      index?: unknown
    }

    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.length > EMBED_MAX_DIMENSIONS ||
      (dimensions && embedding.length !== dimensions) ||
      !embedding.every(
        (value) => typeof value === "number" && isFinite(value),
      ) ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      vectors[index]
    ) {
      throw new PcpError(
        "upstream",
        "The embeddings provider answered a vector PCP cannot read.",
      )
    }

    dimensions = embedding.length
    vectors[index] = Float32Array.from(embedding as number[])
  })

  return vectors
}
