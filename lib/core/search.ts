/**
 * Ranking tools for search_tools. Pure: takes the catalogue rows, returns
 * the best matches. A vault has tens to a few hundred tools, so scoring
 * every row per query is cheaper than keeping an index in step.
 */

export type ToolCandidate = {
  server: string
  serverName: string
  serverDescription: string
  name: string
  title: string | null
  description: string
}

export type ToolMatch = ToolCandidate & { score: number }

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "with",
  "my",
  "me",
  "i",
  "is",
  "how",
  "do",
  "can",
  "get",
])

/** Words from a query or a name: lower case, split on case and symbols. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
}

function stem(word: string): string {
  // Just enough to make "issues" find "issue" and "creating" find "create".
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1)
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2)
  return word
}

function scoreOne(candidate: ToolCandidate, words: string[], query: string) {
  const name = candidate.name.toLowerCase()
  const nameWords = tokenize(candidate.name).map(stem)
  const title = (candidate.title ?? "").toLowerCase()
  const description = candidate.description.toLowerCase()
  const descriptionWords = new Set(tokenize(candidate.description).map(stem))
  const server = `${candidate.server} ${candidate.serverName}`.toLowerCase()
  const serverWords = new Set(
    tokenize(
      `${candidate.server} ${candidate.serverName} ${candidate.serverDescription}`,
    ).map(stem),
  )

  let score = 0

  if (query && (name === query || `${candidate.server}/${name}` === query)) {
    score += 40
  } else if (query && name.includes(query)) {
    score += 15
  }

  for (const raw of words) {
    const word = stem(raw)

    if (nameWords.includes(word)) {
      score += 10
    } else if (nameWords.some((part) => part.startsWith(word))) {
      score += 6
    } else if (name.includes(raw)) {
      score += 4
    }

    if (title.includes(raw)) {
      score += 4
    }

    if (descriptionWords.has(word)) {
      score += 3
    } else if (description.includes(raw)) {
      score += 1
    }

    if (serverWords.has(word) || server.includes(raw)) {
      score += 3
    }
  }

  return score
}

export function searchTools(
  candidates: ToolCandidate[],
  query: string,
  { limit = 10, server }: { limit?: number; server?: string | null } = {},
): ToolMatch[] {
  const scoped = server
    ? candidates.filter((candidate) => candidate.server === server)
    : candidates

  const cleaned = query.trim().toLowerCase()
  const words = tokenize(cleaned).filter((word) => !STOP_WORDS.has(word))

  if (!cleaned || words.length === 0) {
    return scoped
      .slice()
      .sort(
        (a, b) =>
          a.server.localeCompare(b.server) || a.name.localeCompare(b.name),
      )
      .slice(0, limit)
      .map((candidate) => ({ ...candidate, score: 0 }))
  }

  return scoped
    .map((candidate) => ({
      ...candidate,
      score: scoreOne(candidate, words, cleaned),
    }))
    .filter((match) => match.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.server.localeCompare(b.server) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
}

/** The first sentence, cut to fit one line of a search result. */
export function summarize(description: string, max = 140): string {
  const firstLine = description.trim().split(/\r?\n/)[0] ?? ""
  const sentence = firstLine.match(/^(.{8,}?[.!?])(\s|$)/)?.[1] ?? firstLine

  if (sentence.length <= max) {
    return sentence
  }

  return `${sentence.slice(0, max - 1).trimEnd()}…`
}

/** How many tools one list_tools answer names. */
export const LIST_PAGE_SIZE = 200

export type ListedTool = {
  name: string
  title: string | null
  description: string
  access: "allowed" | "ask"
}

/**
 * Every tool on one server, by name, for list_tools: a page at a time, so a
 * server with hundreds of tools is listed whole in a few calls rather than
 * glimpsed through searches. Each line says whether the tool runs at once.
 */
export function listTools(
  server: string,
  tools: ListedTool[],
  {
    offset = 0,
    size = LIST_PAGE_SIZE,
  }: { offset?: number; size?: number } = {},
): string {
  if (tools.length === 0) {
    return `${server} has no tools you can see.`
  }

  const sorted = tools.slice().sort((a, b) => a.name.localeCompare(b.name))

  if (offset >= sorted.length) {
    return `${server} has ${sorted.length} tool${sorted.length === 1 ? "" : "s"}; there is nothing from offset ${offset}.`
  }

  const allowed = sorted.filter((tool) => tool.access === "allowed").length
  const page = sorted.slice(offset, offset + size)
  const end = offset + page.length

  return [
    `${server}: ${sorted.length} tool${sorted.length === 1 ? "" : "s"}, ${allowed} allowed and ${sorted.length - allowed} ask the owner first.${
      offset > 0 || end < sorted.length
        ? ` These are ${offset + 1}–${end}.`
        : ""
    }`,
    ...page.map(
      (tool) =>
        `${server}/${tool.name} [${tool.access}]${tool.title ? ` (${tool.title})` : ""} — ${summarize(tool.description) || "no description"}`,
    ),
    ...(end < sorted.length
      ? [`More: call list_tools again with offset ${end}.`]
      : []),
  ].join("\n")
}
