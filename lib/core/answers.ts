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
 * - `decode` turns base64 (or base64url) text at the paths it names back
 *   into the text it encodes: Gmail sends an email's body that way. A path
 *   there matches wherever the answer's keys end with it, so "body.data" is
 *   every MIME part's body, however deeply the parts nest. What does not
 *   decode to text (an image, a PDF) is left as it was.
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
/** How deep into an answer decode looks. */
const MAX_DECODE_DEPTH = 64

/** How the assistant asked for an answer to be shaped (call_tool's options). */
export type AnswerShape = {
  /** The parts to keep. */
  fields?: string[]
  /** Where base64 text is decoded. */
  decode?: string[]
}

const CUT = "\n… (truncated by PCP)"

/** call_tool's fields, checked: a list of dotted paths. */
export function readFields(
  value: unknown,
  name = "fields",
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FIELDS
  ) {
    throw invalid(`${name} is a list of 1 to ${MAX_FIELDS} paths.`)
  }

  return value.map((field) => {
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > MAX_FIELD_LENGTH ||
      field.split(".").some((part) => part === "")
    ) {
      throw invalid(
        `Each of ${name} is a path of keys joined by dots, like "data.number".`,
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

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/
/** Control characters other than tab and line breaks: binary, not text. */
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/**
 * The text that base64 or base64url (padded or not, with MIME's line breaks
 * or without) encodes, or null when it is not that or does not encode text.
 */
export function decodeBase64Text(value: string): string | null {
  const compact = value.replace(/[\r\n]/g, "")

  if (!BASE64.test(compact) || compact.replace(/=+$/, "").length % 4 === 1) {
    return null
  }

  let text: string

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(compact, "base64"),
    )
  } catch {
    return null
  }

  return NOT_TEXT.test(text) ? null : text
}

type Decoded = {
  /** Values decoded, and values left as they were, per path asked for. */
  decoded: Map<string, number>
  left: Map<string, number>
}

function endsWith(keys: string[], parts: string[]): boolean {
  return (
    parts.length <= keys.length &&
    parts.every(
      (part, index) => keys[keys.length - parts.length + index] === part,
    )
  )
}

function decodeAt(
  value: unknown,
  keys: string[],
  paths: Array<{ path: string; parts: string[] }>,
  tally: Decoded,
): unknown {
  if (typeof value === "string") {
    const match = paths.find(({ parts }) => endsWith(keys, parts))

    if (!match || value === "") {
      return value
    }

    const text = decodeBase64Text(value)
    const counts = text === null ? tally.left : tally.decoded
    counts.set(match.path, (counts.get(match.path) ?? 0) + 1)
    return text ?? value
  }

  if (value === null || typeof value !== "object") {
    return value
  }

  if (keys.length >= MAX_DECODE_DEPTH) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => decodeAt(item, keys, paths, tally))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      decodeAt(item, [...keys, key], paths, tally),
    ]),
  )
}

function counted(counts: Map<string, number>): string {
  return [...counts]
    .map(([path, count]) => `${path} (${count.toLocaleString("en")})`)
    .join(", ")
}

/**
 * A value with the base64 text at the paths decoded, and a note on what
 * was: how many values at each path, which were left encoded because they
 * are not text, and which paths the answer does not have.
 */
export function decodeFields(
  value: unknown,
  decode: string[],
): { value: unknown; notes: string[] } {
  const tally: Decoded = { decoded: new Map(), left: new Map() }
  const decoded = decodeAt(
    value,
    [],
    decode.map((path) => ({ path, parts: path.split(".") })),
    tally,
  )
  const notes: string[] = []

  if (tally.decoded.size > 0) {
    notes.push(`Decoded from base64: ${counted(tally.decoded)}.`)
  }

  if (tally.left.size > 0) {
    notes.push(
      `Left as they were, not base64 text (binary data, like an attachment, stays encoded): ${counted(tally.left)}.`,
    )
  }

  const missing = decode.filter(
    (path) => !tally.decoded.has(path) && !tally.left.has(path),
  )

  if (missing.length > 0) {
    notes.push(`Nothing to decode at: ${missing.join(", ")}.`)
  }

  return { value: decoded, notes }
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
  { fields, decode }: AnswerShape,
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

  // After fields, which keeps the answer's shape: nothing is decoded only
  // to be dropped.
  if (decode) {
    const decoded = decodeFields(shaped, decode)
    shaped = decoded.value
    notes.push(...decoded.notes)
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
  {
    fields,
    decode,
    max = MAX_ANSWER_CHARS,
  }: AnswerShape & { max?: number } = {},
): CallToolResult {
  const shape = { fields, decode }
  const shaping = fields !== undefined || decode !== undefined
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

    for (const text of shapeJson(parsed.value, shape, max)) {
      content.push({ type: "text", text })
    }
  }

  // Asked for fields or decoding with the JSON only in structuredContent:
  // shape that.
  if (shaping && !sawJson && structured !== undefined) {
    for (const text of shapeJson(structured, shape, max)) {
      content.push({ type: "text", text })
    }

    return { content }
  }

  if (shaping && !sawJson) {
    const asked = [fields && "fields", decode && "decode"].filter(Boolean)
    content.unshift({
      type: "text",
      text: `${asked.join(" and ")} ${asked.length > 1 ? "were" : "was"} not applied: the answer is not JSON.`,
    })
  }

  // Shaped text no longer matches structuredContent, and a copy of the
  // text is no use: either way the text is the answer.
  const keepStructured =
    structured !== undefined &&
    !(sawJson && (shaping || repeatsStructured)) &&
    (JSON.stringify(structured)?.length ?? 0) <= max

  return {
    content,
    ...(keepStructured ? { structuredContent: structured } : {}),
  }
}
