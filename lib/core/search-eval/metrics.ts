import { itemsToEmbed } from "../embeddings"
import { cosine } from "../embeddings"
import { searchEverything } from "../search"
import { EVAL_PHRASES, EVAL_TOOLS, type EvalPhrase } from "./catalogue"

/**
 * Judges search's ranking against the fixture catalogue: for each phrase,
 * where the first right answer comes in what search returns. Pure: it runs
 * searchEverything as the gateway does, with or without similarities.
 */

/** How deep a ranking is read: a right answer below is a miss. */
export const EVAL_DEPTH = 20

export type PhraseResult = {
  phrase: string
  /** 1-based place of the first right answer, 0 when it is not in the list. */
  rank: number
  top: string[]
}

export type EvalMetrics = {
  scored: number
  /** Share of phrases whose right answer is in the first three. */
  top3: number
  /** Mean of 1 / rank (0 for a miss). */
  mrr: number
  results: PhraseResult[]
  /** What the unscored phrases (no right answer) came back with. */
  unscored: Array<{ phrase: string; top: string[] }>
}

/** Similarities by semanticKey for one query, as embeddings/ gives search. */
export type Similarities = ReadonlyMap<string, number> | null

export function evaluate(
  rank: (phrase: string) => string[],
  phrases: EvalPhrase[] = EVAL_PHRASES,
): EvalMetrics {
  const results: PhraseResult[] = []
  const unscored: EvalMetrics["unscored"] = []

  for (const { phrase, expected } of phrases) {
    const refs = rank(phrase)

    if (!expected) {
      unscored.push({ phrase, top: refs.slice(0, 3) })
      continue
    }

    const at = refs.findIndex((ref) => expected.includes(ref))
    results.push({
      phrase,
      rank: at < 0 ? 0 : at + 1,
      top: refs.slice(0, 3),
    })
  }

  const scored = results.length

  return {
    scored,
    top3: results.filter((r) => r.rank >= 1 && r.rank <= 3).length / scored,
    mrr:
      results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / scored,
    results,
    unscored,
  }
}

/** The fixture ranked by keywords, or blended with `similarities(phrase)`. */
export function rankFixture(
  similarities: ((phrase: string) => Similarities) | null = null,
): (phrase: string) => string[] {
  return (phrase) =>
    searchEverything({ tools: EVAL_TOOLS }, phrase, {
      limit: EVAL_DEPTH,
      similarities: similarities?.(phrase) ?? null,
    }).map((result) => result.ref)
}

/** The texts search would embed for the fixture (tools only). */
export function fixtureItems() {
  return itemsToEmbed(
    { tools: EVAL_TOOLS },
    { tools: true, skills: false, memories: false },
  )
}

/**
 * Similarities for each phrase from vectors: the items' (by key, in the
 * order of fixtureItems) and a phrase's, as search receives them.
 */
export function similaritiesFrom(
  itemVectors: Float32Array[],
  queryVector: (phrase: string) => Float32Array,
): (phrase: string) => Similarities {
  const items = fixtureItems()

  return (phrase) => {
    const query = queryVector(phrase)
    const scores = new Map<string, number>()

    items.forEach((item, at) => {
      const similarity = cosine(query, itemVectors[at]!)

      if (similarity !== null) {
        scores.set(item.key, similarity)
      }
    })

    return scores
  }
}

export function formatMetrics(label: string, metrics: EvalMetrics): string {
  const lines = metrics.results.map(
    (r) =>
      `  ${r.rank ? String(r.rank).padStart(2) : " -"}  ${r.phrase}  ->  ${r.top.join(", ")}`,
  )

  return [
    `${label}: top-3 ${(metrics.top3 * metrics.scored).toFixed(0)}/${metrics.scored} (${(metrics.top3 * 100).toFixed(0)}%), MRR ${metrics.mrr.toFixed(3)}`,
    ...lines,
    ...metrics.unscored.map(
      (u) => `  ??  ${u.phrase}  ->  ${u.top.join(", ")}`,
    ),
  ].join("\n")
}
