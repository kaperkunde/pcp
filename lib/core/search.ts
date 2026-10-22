/**
 * Ranking for the gateway's search: tools (search_tools ranks those alone),
 * and beside them the skills and memories a token reads. Pure: takes the
 * rows, returns the best matches. A vault has tens to a few hundred tools
 * and skills, so scoring every row per query is cheaper than keeping an
 * index in step.
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

/** A skill as search sees it: its name and description. */
export type SkillCandidate = { name: string; description: string }

/** A memory as search sees it: its full path and its text. */
export type MemoryCandidate = { path: string; text: string }

export type SearchKind = "tool" | "skill" | "memory"

/** One result of search: what it is, how describe names it, one line on it. */
export type SearchResult = {
  kind: SearchKind
  /** tool: server/tool; skill: skill:<name>; memory: its path. */
  ref: string
  /** A tool's title, when it has one. */
  title: string | null
  description: string
  score: number
}

/** Where kinds that score the same come in a list. */
const KIND_ORDER: Record<SearchKind, number> = { skill: 0, tool: 1, memory: 2 }

/**
 * A memory's line in a search: the line that mentions most words of the
 * query, or else its first line that says something.
 */
function memoryLine(text: string, words: string[]): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*(#+|[-*>])\s*/, "").trim())
    .filter(Boolean)
  let best = lines[0] ?? ""
  let most = 0

  for (const line of lines) {
    const lower = line.toLowerCase()
    const hits = words.filter((word) => lower.includes(word)).length

    if (hits > most) {
      best = line
      most = hits
    }
  }

  return summarize(best, 160)
}

/**
 * Tools, skills and memories ranked together for one query, scored the
 * same way: a skill as a tool whose name is its name, a memory as one whose
 * name is its path and whose description is its text. `server` keeps to
 * that server's tools; `kind` to one kind.
 */
export function searchEverything(
  {
    tools,
    skills = [],
    memories = [],
  }: {
    tools: ToolCandidate[]
    skills?: SkillCandidate[]
    memories?: MemoryCandidate[]
  },
  query: string,
  {
    limit = 10,
    server,
    kind,
  }: { limit?: number; server?: string | null; kind?: SearchKind | null } = {},
): SearchResult[] {
  const cleaned = query.trim().toLowerCase()
  const words = tokenize(cleaned).filter((word) => !STOP_WORDS.has(word))
  const wants = (wanted: SearchKind) =>
    (!kind || kind === wanted) && (!server || wanted === "tool")

  const toolResults = wants("tool")
    ? (server ? tools.filter((tool) => tool.server === server) : tools).map(
        (tool): SearchResult => ({
          kind: "tool",
          ref: `${tool.server}/${tool.name}`,
          title: tool.title,
          description: summarize(tool.description) || "no description",
          score: words.length ? scoreOne(tool, words, cleaned) : 0,
        }),
      )
    : []
  const skillResults = wants("skill")
    ? skills.map((skill): SearchResult => {
        const ref = `skill:${skill.name}`
        const score = words.length
          ? scoreOne(
              {
                server: "skill",
                serverName: "skills",
                serverDescription: "procedure how to",
                name: skill.name,
                title: null,
                description: skill.description,
              },
              words,
              cleaned,
            ) + (cleaned === ref ? 40 : 0)
          : 0

        return {
          kind: "skill",
          ref,
          title: null,
          description: summarize(skill.description, 200),
          score,
        }
      })
    : []
  const memoryResults = wants("memory")
    ? memories.map((memory): SearchResult => ({
        kind: "memory",
        ref: memory.path,
        title: null,
        description: memoryLine(memory.text, words) || "(empty)",
        score: words.length
          ? scoreOne(
              {
                server: "memory",
                serverName: "memories",
                serverDescription: "note",
                name: memory.path,
                title: null,
                description: memory.text,
              },
              words,
              cleaned,
            ) + (cleaned === memory.path.toLowerCase() ? 40 : 0)
          : 0,
      }))
    : []

  const order = (a: SearchResult, b: SearchResult) =>
    b.score - a.score ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.ref.localeCompare(b.ref)

  // Nothing to rank by: the skills, then the tools, in name order. A memory
  // is found by what it says, or listed by read_memory.
  if (!cleaned || words.length === 0) {
    return [...skillResults, ...toolResults].sort(order).slice(0, limit)
  }

  return [...toolResults, ...skillResults, ...memoryResults]
    .filter((result) => result.score > 0)
    .sort(order)
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

/**
 * The owner's notes on the servers and skills among a search's results, one
 * line each, in the order they first come up: what the owner said about
 * this one (which host, what it is for). `notes` is by server slug, and by
 * skill ref (skill:<name>).
 */
export function ownerNotesFor(
  refs: string[],
  notes: ReadonlyMap<string, string>,
): string[] {
  const lines: string[] = []
  const seen = new Set<string>()

  for (const ref of refs) {
    const key = ref.split("/")[0]!

    if (key && !seen.has(key) && notes.has(key)) {
      seen.add(key)
      lines.push(`Owner's note on ${key}: ${notes.get(key)}`)
    }
  }

  return lines
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
    about,
  }: {
    offset?: number
    size?: number
    /** The server's name, description and the owner's note, said first. */
    about?: { name: string; description: string; note?: string | null }
  } = {},
): string {
  const lead = about
    ? [
        `${server} (${about.name})${about.description ? `: ${summarize(about.description, 300)}` : ""}`,
        ...(about.note ? [`Owner's note: ${about.note}`] : []),
      ]
    : []

  if (tools.length === 0) {
    return [...lead, `${server} has no tools you can see.`].join("\n")
  }

  const sorted = tools.slice().sort((a, b) => a.name.localeCompare(b.name))

  if (offset >= sorted.length) {
    return `${server} has ${sorted.length} tool${sorted.length === 1 ? "" : "s"}; there is nothing from offset ${offset}.`
  }

  const allowed = sorted.filter((tool) => tool.access === "allowed").length
  const page = sorted.slice(offset, offset + size)
  const end = offset + page.length

  return [
    ...lead,
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
