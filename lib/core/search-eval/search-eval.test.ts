import { describe, expect, it } from "vitest"

import { requestEmbeddings } from "../embeddings/provider"
import { fakeEmbed } from "./fake-embedder"
import {
  evaluate,
  fixtureItems,
  formatMetrics,
  rankFixture,
  similaritiesFrom,
} from "./metrics"

// Search's ranking judged against a fixture catalogue (#175): how often a
// right tool is in the first three, and its mean reciprocal rank. The
// keyword run pins what search does with no provider, the blended run what
// it does with a good (fake) one; neither may fall. A real provider is
// tried by the live run below when PCP_EVAL_EMBEDDINGS_URL is set.

// Measured on the fixture (11 of 14 in the first three; MRR 0.717 and 0.738).
// A change to search that lowers either is a regression to look at, not a
// number to move.
const EPSILON = 1e-9
const KEYWORD_FLOOR = { top3: 11 / 14 - EPSILON, mrr: 0.717 - 0.001 }
const BLENDED_FLOOR = { top3: 11 / 14 - EPSILON, mrr: 0.738 - 0.001 }

const verbose = Boolean(process.env.PCP_EVAL_VERBOSE)

describe("search ranking eval", () => {
  const keywords = evaluate(rankFixture())
  const items = fixtureItems()
  const blended = evaluate(
    rankFixture(
      similaritiesFrom(
        items.map((item) => fakeEmbed(item.text)),
        fakeEmbed,
      ),
    ),
  )

  it("keeps keyword search at or above its floor", () => {
    if (verbose) console.info(formatMetrics("keywords", keywords))

    expect(keywords.scored).toBe(14)
    expect(keywords.top3).toBeGreaterThanOrEqual(KEYWORD_FLOOR.top3)
    expect(keywords.mrr).toBeGreaterThanOrEqual(KEYWORD_FLOOR.mrr)
  })

  it("keeps the blended ranking at or above its floor, and above keywords", () => {
    if (verbose) console.info(formatMetrics("blended (fake)", blended))

    expect(blended.top3).toBeGreaterThanOrEqual(BLENDED_FLOOR.top3)
    expect(blended.mrr).toBeGreaterThanOrEqual(BLENDED_FLOOR.mrr)
    expect(blended.mrr).toBeGreaterThan(keywords.mrr)
  })
})

const url = process.env.PCP_EVAL_EMBEDDINGS_URL

// Live: embeds the fixture through the real provider code. PCP_EVAL_EMBEDDINGS_URL
// is the /embeddings address, _MODEL the model, _STYLE "openai" (default),
// "openai-input-type" or "voyage", _KEY a bearer token if it takes one.
describe.skipIf(!url)("search ranking eval, live provider", () => {
  it("prints the metrics of the provider's own vectors", async () => {
    const style = process.env.PCP_EVAL_EMBEDDINGS_STYLE ?? "openai"
    const request = {
      url: url!,
      style: style === "voyage" ? ("voyage" as const) : ("openai" as const),
      inputType: style === "openai-input-type",
      model: process.env.PCP_EVAL_EMBEDDINGS_MODEL ?? "",
      headers: (process.env.PCP_EVAL_EMBEDDINGS_KEY
        ? { Authorization: `Bearer ${process.env.PCP_EVAL_EMBEDDINGS_KEY}` }
        : {}) as Record<string, string>,
      redact: [],
      sendOptions: {},
    }
    const signal = AbortSignal.timeout(120_000)
    const texts = fixtureItems().map((item) => item.text)
    const vectors: Float32Array[] = []

    for (let at = 0; at < texts.length; at += 64) {
      vectors.push(
        ...(await requestEmbeddings(
          request,
          texts.slice(at, at + 64),
          "document",
          signal,
        )),
      )
    }

    const phrases = (await import("./catalogue")).EVAL_PHRASES.map(
      (entry) => entry.phrase,
    )
    const queries = await requestEmbeddings(request, phrases, "query", signal)
    const byPhrase = new Map(
      phrases.map((phrase, at) => [phrase, queries[at]!]),
    )
    const live = evaluate(
      rankFixture(similaritiesFrom(vectors, (phrase) => byPhrase.get(phrase)!)),
    )

    console.info(
      formatMetrics(`live ${style} ${request.model}`, live),
      "\n",
      formatMetrics("keywords", evaluate(rankFixture())),
    )
    expect(live.scored).toBe(14)
  }, 180_000)
})
