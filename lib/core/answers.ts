import type { CallToolResult } from "@modelcontextprotocol/server"

import { invalid } from "./errors"
import { canonicalJson } from "./permission-rules"

/**
 * What an assistant reads of a tool's answer. An API can answer with far
 * more than an assistant should hold (one invoice list is tens of thousands
 * of characters of HTML terms and line items), so a JSON answer is shaped
 * before it is passed on:
 *
 * - `fields` keeps only the parts asked for, by path ("data.number"); a list
 *   on the way is looked into, so that is the number of every item in data.
 * - An answer still longer than MAX_ANSWER_CHARS becomes a preview that is
 *   valid JSON (each list's first item and how many more, long text cut
 *   short) with a note on how to ask for less, rather than JSON cut off
 *   mid-string.
 * - JSON is passed on compact, once: structuredContent that repeats the text
 *   is dropped, since the gateway's call_tool declares no output schema and
 *   a client that shows both would count it twice.
 *
 * Text that is not JSON is cut at MAX_ANSWER_CHARS, as before.
 */

/** The most of one answer's text an assistant is given. */
export const MAX_ANSWER_CHARS = 60_000
/** Paths one call may ask for, and how long each may be. */
export const MAX_FIELDS = 50
const MAX_FIELD_LENGTH = 200
/** Text longer than this is not parsed to be shaped; it is only cut. */
const MAX_PARSE_CHARS = 5_000_000

const CUT = "\n… (truncated by PCP)"

/** call_tool's fields, checked: a list of dotted paths. */
export function readFields(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FIELDS
  ) {
    throw invalid(`fields is a list of 1 to ${MAX_FIELDS} paths.`)
  }

  return value.map((field) => {
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > MAX_FIELD_LENGTH ||
      field.split(".").some((part) => part === "")
    ) {
      throw invalid(
        'Each field is a path of keys joined by dots, like "data.number".',
      )
    }

    return field
  })
}

type Tree = { [key: string]: Tree | true }

function treeOf(fields: string[]): Tree {
  const tree: Tree = Object.create(null) as Tree

  for (const field of fields) {
    let node = tree
    const parts = field.split(".")

    parts.forEach((part, index) => {
      if (node[part] === true) {
        return
      }

      if (index === parts.length - 1) {
        node[part] = true
        return
      }

      node[part] ??= Object.create(null) as Tree
      node = node[part] as Tree
    })
  }

  return tree
}

/**
 * The parts of a value the paths name, in the value's own shape. Lists are
 * looked into. `found` collects the paths that matched anywhere.
 */
function pick(
  value: unknown,
  tree: Tree | true,
  path: string,
  found: Set<string>,
): unknown {
  if (tree === true) {
    found.add(path)
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => pick(item, tree, path, found))
  }

  if (value === null || typeof value !== "object") {
    return undefined
  }

  const out: Record<string, unknown> = {}

  for (const key of Object.keys(tree)) {
    if (Object.hasOwn(value, key)) {
      const picked = pick(
        (value as Record<string, unknown>)[key],
        tree[key]!,
        path ? `${path}.${key}` : key,
        found,
      )

      if (picked !== undefined) {
        out[key] = picked
      }
    }
  }

  return out
}

/** Only the named paths of a value, and the ones it does not have. */
export function pickFields(
  value: unknown,
  fields: string[],
): { value: unknown; missing: string[] } {
  const found = new Set<string>()
  const picked = pick(value, treeOf(fields), "", found)
  const missing = fields.filter(
    (field) =>
      ![...found].some(
        (match) => match === field || field.startsWith(`${match}.`),
      ),
  )

  return { value: picked, missing }
}

type Cut = { items: number; text: number; depth: number }

/** A value with each list cut to its first items and long text cut short. */
function preview(value: unknown, cut: Cut): unknown {
  if (typeof value === "string") {
    return value.length > cut.text
      ? `${value.slice(0, cut.text)}… (${value.length.toLocaleString("en")} characters)`
      : value
  }

  if (value === null || typeof value !== "object") {
    return value
  }

  if (cut.depth <= 0) {
    return Array.isArray(value) ? `[… ${value.length} items]` : "{…}"
  }

  const inner = { ...cut, depth: cut.depth - 1 }

  if (Array.isArray(value)) {
    const shown = value.slice(0, cut.items).map((item) => preview(item, inner))
    const more = value.length - shown.length
    return more > 0 ? [...shown, `… ${more} more`] : shown
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, preview(item, inner)]),
  )
}

/**
 * Paths worth asking for: the keys of the first list of objects in the
 * answer, like data.id and data.number.
 */
function suggestFields(value: unknown): string[] {
  const queue: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: "", depth: 0 },
  ]

  while (queue.length > 0) {
    const { value: current, path, depth } = queue.shift()!

    if (Array.isArray(current)) {
      const first = current.find(
        (item) => item !== null && typeof item === "object",
      )

      if (first && !Array.isArray(first)) {
        return Object.keys(first)
          .slice(0, 4)
          .map((key) => (path ? `${path}.${key}` : key))
      }
    } else if (current !== null && typeof current === "object" && depth < 3) {
      for (const [key, item] of Object.entries(current)) {
        queue.push({
          value: item,
          path: path ? `${path}.${key}` : key,
          depth: depth + 1,
        })
      }
    }
  }

  return []
}

const CUTS: Cut[] = [
  { items: 1, text: 200, depth: 8 },
  { items: 1, text: 80, depth: 4 },
  { items: 1, text: 40, depth: 2 },
  { items: 0, text: 40, depth: 1 },
]

/** A JSON answer too long to pass on, as a note and a preview that fits. */
function oversized(
  value: unknown,
  length: number,
  max: number,
  fields: string[] | undefined,
): string[] {
  const suggested = suggestFields(value)
  const example =
    suggested.length > 0 ? ` (like ${JSON.stringify(suggested)})` : ""
  const note = `The answer is ${length.toLocaleString("en")} characters, more than PCP passes on (${max.toLocaleString("en")}), so this is a preview: each list shows its first item and how many more there are, and long text is cut short. To get what you need, ask for less: call again with ${fields ? "fewer " : ""}fields to keep only some parts${example}, or for fewer items if the tool takes a page size or a limit.`

  for (const cut of CUTS) {
    const text = JSON.stringify(preview(value, cut))

    if (text.length + note.length <= max) {
      return [note, text]
    }
  }

  return [
    note,
    `${JSON.stringify(preview(value, CUTS.at(-1)!)).slice(0, max - note.length)}${CUT}`,
  ]
}

function parseJson(text: string): { value: unknown } | null {
  const start = text.trimStart()[0]

  if ((start !== "{" && start !== "[") || text.length > MAX_PARSE_CHARS) {
    return null
  }

  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${CUT}` : text
}

/** One JSON value as the texts an assistant reads: notes, then the JSON. */
function shapeJson(
  value: unknown,
  fields: string[] | undefined,
  max: number,
): string[] {
  const notes: string[] = []
  let shaped = value

  if (fields) {
    const picked = pickFields(value, fields)
    shaped = picked.value

    if (picked.missing.length > 0) {
      notes.push(
        `Not in the answer: ${picked.missing.join(", ")}. Kept only the fields asked for that it has.`,
      )
    }
  }

  const text = JSON.stringify(shaped) ?? "null"

  if (text.length <= max) {
    return [...notes, text]
  }

  return [...notes, ...oversized(shaped, text.length, max, fields)]
}

/**
 * A tool's result as the assistant gets it: shaped and cut as described
 * above. An error passes through cut, never shaped: it is what went wrong.
 */
export function shapeAnswer(
  result: CallToolResult,
  { fields, max = MAX_ANSWER_CHARS }: { fields?: string[]; max?: number } = {},
): CallToolResult {
  const blocks = result.content ?? []

  if (result.isError) {
    return {
      ...result,
      content: blocks.map((block) =>
        block.type === "text"
          ? { ...block, text: clip(block.text, max) }
          : block,
      ),
    }
  }

  const structured = result.structuredContent
  let sawJson = false
  let repeatsStructured = false
  const content: CallToolResult["content"] = []

  for (const block of blocks) {
    const parsed = block.type === "text" ? parseJson(block.text) : null

    if (block.type !== "text" || !parsed) {
      content.push(
        block.type === "text"
          ? { ...block, text: clip(block.text, max) }
          : block,
      )
      continue
    }

    sawJson = true
    // An API's answer that is not an object is passed as { value } there.
    repeatsStructured ||=
      structured !== undefined &&
      [parsed.value, { value: parsed.value }].some(
        (candidate) => canonicalJson(candidate) === canonicalJson(structured),
      )

    for (const text of shapeJson(parsed.value, fields, max)) {
      content.push({ type: "text", text })
    }
  }

  // Asked for fields with the JSON only in structuredContent: shape that.
  if (fields && !sawJson && structured !== undefined) {
    for (const text of shapeJson(structured, fields, max)) {
      content.push({ type: "text", text })
    }

    return { content }
  }

  if (fields && !sawJson) {
    content.unshift({
      type: "text",
      text: "fields was not applied: the answer is not JSON.",
    })
  }

  // Shaped text no longer matches structuredContent, and a copy of the
  // text is no use: either way the text is the answer.
  const keepStructured =
    structured !== undefined &&
    !(sawJson && (fields || repeatsStructured)) &&
    (JSON.stringify(structured)?.length ?? 0) <= max

  return {
    content,
    ...(keepStructured ? { structuredContent: structured } : {}),
  }
}
