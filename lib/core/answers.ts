import type { CallToolResult } from "@modelcontextprotocol/server"

import { invalid, isPcpError } from "./errors"
import { isTextBytes, sniffMediaType } from "./media-types"
import { canonicalJson } from "./permission-rules"
import { handleOf, type KeptResult, type ResultHandle } from "./tool-results"

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
 *
 * With a keeper (shapeAnswerKeeping, which every upstream call goes
 * through), large values become results kept for the token and are shown as
 * handles, {"$result": id, ...}, that any later call can name in their place
 * (lib/core/result-handles.ts):
 *
 * - `keep` names the parts to keep that way, whatever their size;
 * - base64 that decodes to a file (an image, a PDF, a zip) is kept as the
 *   file's bytes on sight: it is no use to read and costs thousands of
 *   characters;
 * - an answer still too long has its longest texts kept, longest first,
 *   until it fits, before anything is cut to a preview.
 *
 * An image, audio or embedded file block is kept as bytes too; one too large
 * to pass on is replaced by its handle.
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
  /** The parts kept as results and shown as handles. */
  keep?: string[]
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

/** A JSON value's fields and decoding applied, with notes on what was done. */
function applyShape(
  value: unknown,
  { fields, decode }: AnswerShape,
): { value: unknown; notes: string[] } {
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

  return { value: shaped, notes }
}

/** One JSON value as the texts an assistant reads: notes, then the JSON. */
function renderJson(
  value: unknown,
  notes: string[],
  max: number,
  fields: string[] | undefined,
): string[] {
  const text = JSON.stringify(value) ?? "null"

  if (text.length <= max) {
    return [...notes, text]
  }

  return [...notes, ...oversized(value, text.length, max, fields)]
}

type Block = CallToolResult["content"][number]

type Part =
  | { kind: "block"; block: Block }
  | { kind: "json"; value: unknown; notes: string[] }

/**
 * An answer parsed and shaped, before it is cut to a length: rendered once
 * for the assistant and, when that left something out, once more whole.
 */
type Prepared = {
  error: CallToolResult | null
  parts: Part[]
  fields: string[] | undefined
  structured: unknown
  /** The JSON came from structuredContent, shaped as asked. */
  fromStructured: boolean
  /** Why fields or decode did nothing. */
  notApplied: string | null
  /** structuredContent may be passed on beside the text. */
  keepStructured: boolean
}

function prepareAnswer(
  result: CallToolResult,
  { fields, decode, keep }: AnswerShape,
): Prepared {
  const blocks = result.content ?? []
  const structured = result.structuredContent

  if (result.isError) {
    return {
      error: result,
      parts: [],
      fields,
      structured,
      fromStructured: false,
      notApplied: null,
      keepStructured: false,
    }
  }

  const shaping = fields !== undefined || decode !== undefined
  let sawJson = false
  let repeatsStructured = false
  const parts: Part[] = []

  for (const block of blocks) {
    const parsed = block.type === "text" ? parseJson(block.text) : null

    if (!parsed) {
      parts.push({ kind: "block", block })
      continue
    }

    sawJson = true
    // An API's answer that is not an object is passed as { value } there.
    repeatsStructured ||=
      structured !== undefined &&
      [parsed.value, { value: parsed.value }].some(
        (candidate) => canonicalJson(candidate) === canonicalJson(structured),
      )
    parts.push({
      kind: "json",
      ...applyShape(parsed.value, { fields, decode }),
    })
  }

  // Asked for fields, decoding or keeping with the JSON only in
  // structuredContent: shape that.
  const fromStructured =
    (shaping || keep !== undefined) && !sawJson && structured !== undefined

  if (fromStructured) {
    parts.push({ kind: "json", ...applyShape(structured, { fields, decode }) })
  }

  const asked = [fields && "fields", decode && "decode", keep && "keep"].filter(
    Boolean,
  )

  return {
    error: null,
    parts,
    fields,
    structured,
    fromStructured,
    notApplied:
      asked.length > 0 && !sawJson && !fromStructured
        ? `${asked.join(" and ")} ${asked.length > 1 ? "were" : "was"} not applied: the answer is not JSON.`
        : null,
    // Shaped text no longer matches structuredContent, and a copy of the
    // text is no use: either way the text is the answer.
    keepStructured:
      structured !== undefined && !(sawJson && (shaping || repeatsStructured)),
  }
}

function renderAnswer(prepared: Prepared, max: number): CallToolResult {
  if (prepared.error) {
    return {
      ...prepared.error,
      content: (prepared.error.content ?? []).map((block) =>
        block.type === "text"
          ? { ...block, text: clip(block.text, max) }
          : block,
      ),
    }
  }

  const content: CallToolResult["content"] = []

  if (prepared.notApplied) {
    content.push({ type: "text", text: prepared.notApplied })
  }

  for (const part of prepared.parts) {
    if (part.kind === "block") {
      content.push(
        part.block.type === "text"
          ? { ...part.block, text: clip(part.block.text, max) }
          : part.block,
      )
      continue
    }

    for (const text of renderJson(
      part.value,
      part.notes,
      max,
      prepared.fields,
    )) {
      content.push({ type: "text", text })
    }
  }

  if (prepared.fromStructured) {
    return { content }
  }

  const keepStructured =
    prepared.keepStructured &&
    (JSON.stringify(prepared.structured)?.length ?? 0) <= max

  return {
    content,
    ...(keepStructured ? { structuredContent: prepared.structured } : {}),
  }
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
  }: Omit<AnswerShape, "keep"> & { max?: number } = {},
): CallToolResult {
  return renderAnswer(prepareAnswer(result, { fields, decode }), max)
}

/** Strings at least this long that decode to a file are kept on sight. */
export const MIN_AUTO_BYTES_CHARS = 1_024
/** Texts at least this long are kept when an answer is still too long. */
export const MIN_AUTO_TEXT_CHARS = 2_000
export const MAX_AUTO_TEXT_HANDLES = 20
/** All the handles one answer may make, whatever made them. */
export const MAX_HANDLES_PER_ANSWER = 50
export const HANDLE_PREVIEW_CHARS = 200
/** Paths a handle note names before "and N more". */
const MAX_NOTED_HANDLES = 10

/** Keeps a value of an answer for the token the call was made for. */
export type AnswerKeepers = {
  text(input: {
    text: string
    mediaType: string
    name?: string | null
  }): Promise<KeptResult>
  bytes(input: {
    bytes: Buffer
    mediaType: string
    name: string | null
  }): Promise<KeptResult>
}

const HEX = /^[0-9a-fA-F]+$/

/**
 * The file a string is the base64 of, or null. Only bytes that are not text
 * count. A file type known by its first bytes is taken from anything; any
 * other bytes only from standard base64 that looks it (padded to whole
 * groups, both cases and digits, + or /, not hex), so an id or a digest
 * that merely uses the alphabet stays text.
 */
function fileOf(
  value: string,
  minChars: number,
): { bytes: Buffer; type: string | null } | null {
  if (value.length < minChars) {
    return null
  }

  const compact = value.replace(/[\r\n]/g, "")

  if (!BASE64.test(compact) || compact.replace(/=+$/, "").length % 4 === 1) {
    return null
  }

  const bytes = Buffer.from(compact, "base64")

  if (bytes.length === 0 || isTextBytes(bytes)) {
    return null
  }

  const sniffed = sniffMediaType(bytes)

  if (sniffed) {
    return { bytes, type: sniffed }
  }

  const looksLikeBase64 =
    compact.length % 4 === 0 &&
    /[A-Z]/.test(compact) &&
    /[a-z]/.test(compact) &&
    /[0-9]/.test(compact) &&
    /[+/]/.test(compact) &&
    !HEX.test(compact)

  return looksLikeBase64 ? { bytes, type: null } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function siblingString(
  siblings: Record<string, unknown> | null,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = siblings?.[key]

    if (typeof value === "string" && value.trim() !== "") {
      return value
    }
  }

  return null
}

const NAME_KEYS = ["filename", "fileName", "name", "title"]
const TYPE_KEYS = ["mimeType", "contentType", "mediaType", "type"]

function sizeOf(handle: ResultHandle): string {
  return handle.size !== undefined
    ? `${handle.size.toLocaleString("en")} bytes`
    : `${(handle.length ?? 0).toLocaleString("en")} characters`
}

/** Makes the handles of one answer, and says what it made. */
class Handles {
  made: Array<{ path: string; handle: ResultHandle }> = []
  /** Handles already in the answer: a mail tool keeps its own. */
  seen: Array<{ path: string; handle: ResultHandle }> = []
  capped = false

  constructor(
    private readonly keepers: AnswerKeepers,
    private readonly keep: Array<{ path: string; parts: string[] }>,
  ) {}

  private room(): boolean {
    if (this.made.length >= MAX_HANDLES_PER_ANSWER) {
      this.capped = true
      return false
    }

    return true
  }

  /** A kept value's handle, or null when it could not be kept. */
  private async kept(
    path: string,
    make: () => Promise<KeptResult>,
    preview?: string,
  ): Promise<ResultHandle | null> {
    try {
      const handle = handleOf(await make(), preview)
      this.made.push({ path, handle })
      return handle
    } catch (error) {
      // Too large to keep: it stays as it was.
      if (isPcpError(error)) {
        return null
      }

      throw error
    }
  }

  private keepText(path: string, text: string, mediaType: string) {
    return this.kept(
      path,
      () => this.keepers.text({ text, mediaType }),
      text.slice(0, HANDLE_PREVIEW_CHARS),
    )
  }

  private keepFile(
    path: string,
    file: { bytes: Buffer; type: string | null },
    siblings: Record<string, unknown> | null,
  ) {
    const declared = siblingString(siblings, TYPE_KEYS)

    return this.kept(path, () =>
      this.keepers.bytes({
        bytes: file.bytes,
        mediaType:
          file.type ??
          (declared?.includes("/") ? declared : "application/octet-stream"),
        name: siblingString(siblings, NAME_KEYS),
      }),
    )
  }

  /** Rules a (keep) and b (files on sight), over one JSON value. */
  async transform(
    value: unknown,
    keys: string[] = [],
    path = "",
    siblings: Record<string, unknown> | null = null,
  ): Promise<unknown> {
    if (keys.length >= MAX_DECODE_DEPTH) {
      return value
    }

    const asked = this.keep.some(({ parts }) => endsWith(keys, parts))

    if (asked && value !== null && typeof value === "object") {
      if (!this.room()) {
        return value
      }

      return (
        (await this.keepText(
          path,
          JSON.stringify(value),
          "application/json",
        )) ?? value
      )
    }

    if (typeof value === "string") {
      if (value === "" || !(asked || value.length >= MIN_AUTO_BYTES_CHARS)) {
        return value
      }

      const file = fileOf(value, asked ? 64 : MIN_AUTO_BYTES_CHARS)

      if (!file && !asked) {
        return value
      }

      if (!this.room()) {
        return value
      }

      return (
        (file
          ? await this.keepFile(path, file, siblings)
          : await this.keepText(path, value, "text/plain")) ?? value
      )
    }

    if (Array.isArray(value)) {
      const out: unknown[] = []

      for (const [index, item] of value.entries()) {
        out.push(await this.transform(item, keys, `${path}[${index}]`, null))
      }

      return out
    }

    if (isRecord(value)) {
      if (isHandleObject(value)) {
        this.seen.push({ path, handle: value })
        return value
      }

      const out: Record<string, unknown> = {}

      for (const [key, item] of Object.entries(value)) {
        out[key] = await this.transform(
          item,
          [...keys, key],
          path ? `${path}.${key}` : key,
          value,
        )
      }

      return out
    }

    return value
  }

  /** Rule c: the longest texts kept until the value fits in max. */
  async shrink(value: unknown, max: number): Promise<void> {
    let total = (JSON.stringify(value) ?? "").length

    if (total <= max) {
      return
    }

    const candidates: Array<{
      holder: Record<string, unknown> | unknown[]
      key: string | number
      path: string
      text: string
    }> = []

    const walk = (node: unknown, path: string, depth: number) => {
      if (depth >= MAX_DECODE_DEPTH) {
        return
      }

      const entries: Array<[string | number, unknown, string]> = Array.isArray(
        node,
      )
        ? node.map((item, index) => [index, item, `${path}[${index}]`])
        : isRecord(node) && !("$result" in node)
          ? Object.entries(node).map(([key, item]) => [
              key,
              item,
              path ? `${path}.${key}` : key,
            ])
          : []

      for (const [key, item, itemPath] of entries) {
        if (typeof item === "string" && item.length >= MIN_AUTO_TEXT_CHARS) {
          candidates.push({
            holder: node as Record<string, unknown>,
            key,
            path: itemPath,
            text: item,
          })
        } else {
          walk(item, itemPath, depth + 1)
        }
      }
    }

    walk(value, "", 0)
    candidates.sort((a, b) => b.text.length - a.text.length)

    let made = 0

    for (const candidate of candidates) {
      if (total <= max || made >= MAX_AUTO_TEXT_HANDLES || !this.room()) {
        break
      }

      const handle = await this.keepText(
        candidate.path,
        candidate.text,
        "text/plain",
      )

      if (handle) {
        ;(candidate.holder as Record<string | number, unknown>)[candidate.key] =
          handle
        total -=
          JSON.stringify(candidate.text).length - JSON.stringify(handle).length
        made += 1
      }
    }
  }

  /** An image, audio or embedded file block, kept as bytes. */
  async block(block: Block, max: number): Promise<Block[]> {
    const file =
      block.type === "image" || block.type === "audio"
        ? {
            data: block.data,
            type: block.mimeType,
            name: null,
            what: block.type,
          }
        : block.type === "resource" && "blob" in block.resource
          ? {
              data: block.resource.blob,
              type: block.resource.mimeType ?? null,
              name:
                block.resource.uri.split(/[/?#]/).filter(Boolean).pop() ?? null,
              what: "file",
            }
          : null

    if (!file || !this.room()) {
      return [block]
    }

    const bytes = Buffer.from(file.data, "base64")
    const handle = await this.kept(block.type, () =>
      this.keepers.bytes({
        bytes,
        mediaType:
          file.type ?? sniffMediaType(bytes) ?? "application/octet-stream",
        name: file.name,
      }),
    )

    if (!handle) {
      return [block]
    }

    const json = JSON.stringify(handle)

    return file.data.length > max
      ? [
          {
            type: "text",
            text: `PCP kept this ${file.what} as a result, too large to pass on here: ${json}`,
          },
        ]
      : [
          block,
          {
            type: "text",
            text: `PCP kept this ${file.what} as a result too, to hand to another tool: ${json}`,
          },
        ]
  }

  /** The note for the handles made since `from`, or null for none. */
  note(from: number): string | null {
    const made = this.made.slice(from)

    if (made.length === 0) {
      return null
    }

    const named = made
      .slice(0, MAX_NOTED_HANDLES)
      .map(
        ({ path, handle }) =>
          `${path || "(the answer)"} → ${handle.$result} (${handle.type}, ${sizeOf(handle)})`,
      )
      .join("; ")
    const more =
      made.length > MAX_NOTED_HANDLES
        ? `; and ${made.length - MAX_NOTED_HANDLES} more`
        : ""
    const capped = this.capped
      ? ` PCP keeps at most ${MAX_HANDLES_PER_ANSWER} per answer: ask for fewer fields for the rest.`
      : ""

    return `PCP kept ${made.length} value${made.length === 1 ? "" : "s"} of this answer as results, each shown as {"$result": …}: ${named}${more}. Pass a handle as it is in any tool's arguments, where it stands for the value (a file as base64, or as text with "as": "text"); read_result reads a text one.${capped}`
  }
}

/** A handle PCP wrote into an answer itself (a mail tool's). */
function isHandleObject(value: Record<string, unknown>): value is ResultHandle {
  return (
    typeof value.$result === "string" &&
    typeof value.type === "string" &&
    typeof value.readableUntil === "string"
  )
}

/** Where a client that reads resources finds a kept result. */
export function resultUri(id: string): string {
  return `pcp://results/${encodeURIComponent(id)}`
}

/**
 * A resource link for each handle, after the answer: a client that reads
 * resources can fetch the value itself (resources/read), and one that does
 * not still has the handle in the text.
 */
function resourceLinks(
  handles: Array<{ path: string; handle: ResultHandle }>,
): Block[] {
  const unique = new Map(handles.map((entry) => [entry.handle.$result, entry]))

  return [...unique.values()].map(({ path, handle }) => ({
    type: "resource_link",
    uri: resultUri(handle.$result),
    name: handle.name ?? (path || handle.$result),
    mimeType: handle.type,
    description: `Kept by PCP until ${handle.readableUntil}; {"$result": "${handle.$result}"} passes it to a tool.`,
  }))
}

/**
 * A tool's result as the assistant gets it, with large values kept as
 * results for the token and shown as handles (see above). With `links`,
 * each handle also gets a resource link after the answer. `shown` is cut to
 * `max`; `whole()` renders the same shaped answer, with the same handles, up
 * to `wholeMax`, for keepWholeAnswer to keep when `shown` left anything out.
 */
export async function shapeAnswerKeeping(
  result: CallToolResult,
  { fields, decode, keep }: AnswerShape,
  keepers: AnswerKeepers,
  {
    max = MAX_ANSWER_CHARS,
    wholeMax,
    links = false,
  }: { max?: number; wholeMax: number; links?: boolean },
): Promise<{ shown: CallToolResult; whole: () => CallToolResult }> {
  const prepared = prepareAnswer(result, { fields, decode, keep })
  let linked: Block[] = []

  if (!prepared.error) {
    const handles = new Handles(
      keepers,
      (keep ?? []).map((path) => ({ path, parts: path.split(".") })),
    )
    const parts: Part[] = []

    for (const part of prepared.parts) {
      if (part.kind === "block") {
        for (const block of await handles.block(part.block, max)) {
          parts.push({ kind: "block", block })
        }

        continue
      }

      const from = handles.made.length
      const value = await handles.transform(part.value)
      const notesLength = part.notes.reduce((sum, note) => sum + note.length, 0)
      await handles.shrink(value, max - notesLength)
      const note = handles.note(from)

      parts.push({
        kind: "json",
        value,
        notes: note ? [...part.notes, note] : part.notes,
      })
    }

    prepared.parts = parts

    if (handles.made.length > 0) {
      prepared.keepStructured = false
    }

    if (links) {
      linked = resourceLinks([...handles.made, ...handles.seen])
    }
  }

  const shown = renderAnswer(prepared, max)

  return {
    shown:
      linked.length > 0
        ? { ...shown, content: [...shown.content, ...linked] }
        : shown,
    whole: () => renderAnswer(prepared, wholeMax),
  }
}
