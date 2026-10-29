/**
 * Ranking for the gateway's search: tools (searchTools ranks those alone),
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

/** A name's tier: an exact match ranks above everything, a prefix next. */
const EXACT = 1000
const PREFIX = 500

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

/**
 * A name as an exact match compares it: lower case, its words (by case or
 * by any of - _ . and spaces) joined by _, a / kept. "check-permission",
 * "Check permission" and "checkPermission" are all check_permission.
 */
export function normalName(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "_")
    .replace(/_*\/_*/g, "/")
    .replace(/^_+|_+$/g, "")
}

/**
 * What a name may be once an app's prefix for a server's tools is taken
 * off (mcp__PCP_Bazzite__run_code, as Claude's apps name PCP's tools): the
 * text itself first, then what follows each __ after mcp__.
 */
function withoutClientPrefix(text: string): string[] {
  const variants = [text]

  if (/^mcp__/i.test(text)) {
    for (
      let at = text.indexOf("__", 6);
      at >= 0;
      at = text.indexOf("__", at + 1)
    ) {
      const rest = text.slice(at + 2)

      if (rest && !rest.startsWith("_")) {
        variants.push(rest)
      }
    }
  }

  return variants
}

/**
 * A name given with an app's prefix (mcp__<server>__<name>) and the one of
 * `names` it stands for, or null when it has no such prefix or names none.
 */
export function clientPrefixed(
  text: string,
  names: Iterable<string>,
): { prefix: string; name: string } | null {
  const given = text.trim()
  const known = new Map([...names].map((name) => [normalName(name), name]))

  for (const variant of withoutClientPrefix(given).slice(1)) {
    const name = known.get(normalName(variant))

    if (name) {
      return { prefix: given.slice(0, given.length - variant.length), name }
    }
  }

  return null
}

/** What search and describe say when a name came with an app's prefix. */
export function clientPrefixNote(prefixed: {
  prefix: string
  name: string
}): string {
  return `"${prefixed.prefix}" is your app's prefix for PCP's tools, not part of the name: the tool is ${prefixed.name}, and you call it directly.`
}

/** A query, read once for every candidate. */
type Query = {
  /** Lower case, trimmed. */
  cleaned: string
  /** Its words, stop words left out. */
  words: string[]
  /**
   * What would be a tool's name: the whole query, and each term in it that
   * reads as a name (it has _ - . / or a capital inside), each also without
   * an app's prefix, as normalName writes them.
   */
  names: string[]
}

function readQuery(query: string): Query {
  const raw = query.trim()
  const cleaned = raw.toLowerCase()
  const terms = raw
    .split(/\s+/)
    .filter((term) => /[_./-]|[a-z][A-Z]/.test(term) && term !== raw)

  return {
    cleaned,
    words: tokenize(cleaned).filter((word) => !STOP_WORDS.has(word)),
    names: [
      ...new Set(
        [raw, ...terms]
          .flatMap(withoutClientPrefix)
          .map(normalName)
          .filter(Boolean),
      ),
    ],
  }
}

/**
 * The words of a query that some candidate has in its name, its title, or
 * its server's short name or name: for those, a server's description or
 * the owner's note on it counts for nothing, so a word ("PCP") that a
 * server's description happens to use does not lift each of its tools over
 * the tools named by it.
 */
function namedWords(candidates: ToolCandidate[], words: string[]): Set<string> {
  const named = new Set<string>()

  for (const candidate of candidates) {
    if (named.size === words.length) break

    const text =
      `${candidate.name} ${candidate.title ?? ""} ${candidate.server} ${candidate.serverName}`.toLowerCase()
    const stems = new Set(tokenize(text).map(stem))

    for (const word of words) {
      if (stems.has(stem(word)) || text.includes(word)) {
        named.add(word)
      }
    }
  }

  return named
}

/** Whether a word of the query is in a candidate's name or title. */
function namesAWord(candidate: ToolCandidate, words: string[]): boolean {
  const text = `${candidate.name} ${candidate.title ?? ""}`.toLowerCase()
  const stems = new Set(tokenize(text).map(stem))

  return words.some((word) => stems.has(stem(word)) || text.includes(word))
}

/** EXACT when the query names the candidate, PREFIX when it starts its name. */
function nameTier(candidate: ToolCandidate, names: string[]): number {
  const bare = normalName(candidate.name)
  const full = normalName(`${candidate.server}/${candidate.name}`)

  if (names.some((name) => name === bare || name === full)) {
    return EXACT
  }

  return names.some(
    (name) =>
      name.length >= 3 &&
      (bare.startsWith(name) || (name.includes("/") && full.startsWith(name))),
  )
    ? PREFIX
    : 0
}

function scoreOne(
  candidate: ToolCandidate,
  { words, cleaned: query, names }: Query,
  named: ReadonlySet<string> | null = null,
) {
  const name = candidate.name.toLowerCase()
  const nameWords = tokenize(candidate.name).map(stem)
  const title = (candidate.title ?? "").toLowerCase()
  const description = candidate.description.toLowerCase()
  const descriptionWords = new Set(tokenize(candidate.description).map(stem))
  const server = `${candidate.server} ${candidate.serverName}`.toLowerCase()
  const serverWords = new Set(tokenize(server).map(stem))
  const aboutServer = new Set(tokenize(candidate.serverDescription).map(stem))

  let score = nameTier(candidate, names)

  if (!score && query && name.includes(query)) {
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

    if (
      serverWords.has(word) ||
      server.includes(raw) ||
      (aboutServer.has(word) && !named?.has(raw))
    ) {
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

  const read = readQuery(query)
  const { cleaned, words } = read

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

  const named = namedWords(candidates, words)

  return scoped
    .map((candidate) => ({
      ...candidate,
      score: scoreOne(candidate, read, named),
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

/**
 * One of PCP's own tools the token has (gateway.ts registers them), which
 * an assistant calls directly, never through call_tool.
 */
export type PcpToolCandidate = {
  name: string
  title: string
  description: string
}

export type SearchKind = "tool" | "pcp" | "skill" | "memory"

/** What a result of kind pcp says after its line. */
export const PCP_TOOL_NOTE =
  "PCP's own tool: call it directly (not through call_tool)."

/** One result of search: what it is, how describe names it, one line on it. */
export type SearchResult = {
  kind: SearchKind
  /**
   * tool: server/tool; pcp: the tool's name; skill: skill:<name>; memory:
   * its path.
   */
  ref: string
  /** A tool's title, when it has one. */
  title: string | null
  description: string
  score: number
}

/** Where kinds that score the same come in a list. */
const KIND_ORDER: Record<SearchKind, number> = {
  skill: 0,
  tool: 1,
  pcp: 2,
  memory: 3,
}

/** One of PCP's own tools, scored as a tool on a server called pcp. */
function pcpCandidate(tool: PcpToolCandidate): ToolCandidate {
  return {
    server: "pcp",
    serverName: "PCP",
    serverDescription: "",
    name: tool.name,
    title: tool.title,
    description: tool.description,
  }
}

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
 * Tools, PCP's own tools, skills and memories ranked together for one
 * query, scored the same way: one of PCP's tools as a tool on a server
 * called pcp, a skill as a tool whose name is its name, a memory as one
 * whose name is its path and whose description is its text. A name the
 * query gives exactly comes first, then one it starts. `server` keeps to
 * that server's tools; `kind` to one kind.
 */
export function searchEverything(
  {
    tools,
    pcp = [],
    skills = [],
    memories = [],
  }: {
    tools: ToolCandidate[]
    pcp?: PcpToolCandidate[]
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
  const read = readQuery(query)
  const { cleaned, words } = read
  const wants = (wanted: SearchKind) =>
    (!kind || kind === wanted) && (!server || wanted === "tool")
  const own = pcp.map(pcpCandidate)
  const named = words.length ? namedWords([...tools, ...own], words) : null

  const toolResults = wants("tool")
    ? (server ? tools.filter((tool) => tool.server === server) : tools).map(
        (tool): SearchResult => ({
          kind: "tool",
          ref: `${tool.server}/${tool.name}`,
          title: tool.title,
          description: summarize(tool.description) || "no description",
          score: words.length ? scoreOne(tool, read, named) : 0,
        }),
      )
    : []
  const pcpResults = wants("pcp")
    ? own.map((tool): SearchResult => ({
        kind: "pcp",
        ref: tool.name,
        title: tool.title,
        description: `${summarize(tool.description)} ${PCP_TOOL_NOTE}`,
        // The app lists PCP's tools whole already: one comes up by its
        // name or title (or for "pcp"), not by a word of its description.
        score:
          words.length &&
          (namesAWord(tool, words) ||
            nameTier(tool, read.names) > 0 ||
            words.every((word) => word === "pcp"))
            ? scoreOne(tool, read, named)
            : 0,
      }))
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
              read,
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
              read,
            ) + (cleaned === memory.path.toLowerCase() ? 40 : 0)
          : 0,
      }))
    : []

  const order = (a: SearchResult, b: SearchResult) =>
    b.score - a.score ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.ref.localeCompare(b.ref)

  // Nothing to rank by: the skills, then the tools, in name order (PCP's
  // own only when asked for: the app lists those already). A memory is
  // found by what it says, or listed by read_memory.
  if (!cleaned || words.length === 0) {
    return [
      ...skillResults,
      ...toolResults,
      ...(kind === "pcp" ? pcpResults : []),
    ]
      .sort(order)
      .slice(0, limit)
  }

  return [...toolResults, ...pcpResults, ...skillResults, ...memoryResults]
    .filter((result) => result.score > 0)
    .sort(order)
    .slice(0, limit)
}

/** One of PCP's own tools as describe gives it. */
export type OwnToolDescription = PcpToolCandidate & {
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown> | undefined
  annotations: Record<string, boolean>
}

/**
 * describe's answer for one of PCP's own tools: what it is and its schemas,
 * and that it is called directly, so it has no call_handle. `note` says
 * first what describe made of the name it was given.
 */
export function describeOwnTool(
  tool: OwnToolDescription,
  note: string | null = null,
): string {
  return JSON.stringify(
    {
      ...(note ? { note } : {}),
      tool: tool.name,
      kind: "pcp",
      call: `PCP's own tool: call ${tool.name} directly, with arguments that match its inputSchema, not through call_tool. It has no call_handle.`,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
    },
    null,
    1,
  )
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
