import { invalid } from "./errors"
import type { OpenedResult, ResultOpener } from "./tool-results"

/**
 * A handle in a call's arguments: {"$result": "<id>"} stands for a kept
 * result (lib/core/tool-results.ts) wherever a tool wants a string, so a long
 * text or a file read from one tool reaches another without passing through
 * the assistant. {"$result": id, "as": "text" | "base64"} says which form:
 *
 * - a kept text is its text, or its UTF-8 bytes as base64;
 * - a kept file is its bytes as base64, or its text when it is of a text type.
 *
 * Only an object with nothing but those keys is a handle, so an API's own
 * "$result" property is left as it is. This file reads no secret and touches
 * no database: the opener it is given does that, for one token.
 */

export const MAX_HANDLE_DEPTH = 64
export const MAX_HANDLE_NODES = 10_000
/** The most characters all handles of one call may add up to. */
export const MAX_RESOLVED_CHARS = 16_000_000

export type Handle = { $result: string; as?: "text" | "base64" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The handle a value is, null when it is not one; a bad `as` is refused. */
export function parseHandle(value: unknown): Handle | null {
  if (!isRecord(value)) {
    return null
  }

  const keys = Object.keys(value)

  if (
    !keys.includes("$result") ||
    keys.some((key) => key !== "$result" && key !== "as")
  ) {
    return null
  }

  const id = value.$result

  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return null
  }

  if (value.as !== undefined && value.as !== "text" && value.as !== "base64") {
    throw invalid(`A handle's "as" is "text" or "base64".`)
  }

  return { $result: id, ...(value.as ? { as: value.as } : {}) }
}

/**
 * The result id an object names, looser than a handle: an attachment
 * ({"$result", "name", "type"}) names one too. Used to say what a call
 * carries and to check its ids exist, never to replace anything.
 */
function referenceOf(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }

  const id = value.$result

  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= 64 &&
    Object.keys(value).every((key) => REFERENCE_KEYS.has(key))
    ? id
    : null
}

const REFERENCE_KEYS = new Set(["$result", "as", "name", "type"])

type Walk = { nodes: number }

function step(walk: Walk, depth: number): void {
  if (depth > MAX_HANDLE_DEPTH) {
    throw invalid(`Arguments nest deeper than ${MAX_HANDLE_DEPTH} levels.`)
  }

  if (++walk.nodes > MAX_HANDLE_NODES) {
    throw invalid(`Arguments hold more than ${MAX_HANDLE_NODES} values.`)
  }
}

function collect(
  value: unknown,
  found: Set<string>,
  walk: Walk,
  depth: number,
  loose: boolean,
): void {
  step(walk, depth)

  const id = loose ? referenceOf(value) : parseHandle(value)?.$result

  if (id) {
    found.add(id)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, found, walk, depth + 1, loose)
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collect(item, found, walk, depth + 1, loose)
    }
  }
}

/**
 * Every result id the arguments name, once each, in order of appearance:
 * handles, and with `loose` attachments too ({"$result", "name", "type"}).
 */
export function collectHandleIds(
  args: unknown,
  { loose = false }: { loose?: boolean } = {},
): string[] {
  const found = new Set<string>()
  collect(args, found, { nodes: 0 }, 0, loose)

  return [...found]
}

export function missingResultMessage(id: string): string {
  return `No kept result "${id}" for this token: it has expired, was kept for another token, or the id is wrong. Call the tool that produced it again.`
}

function contentOf(opened: OpenedResult, as: Handle["as"]): string {
  if (opened.kind === "bytes") {
    return as === "text" ? opened.text() : opened.bytes().toString("base64")
  }

  return as === "base64" ? opened.bytes().toString("base64") : opened.text()
}

/**
 * The arguments with every handle replaced by what it stands for. An id the
 * token has no result for is refused by name before anything is sent.
 * `skip` names top-level arguments left alone (the mail tools resolve
 * `attachments` themselves, as bytes).
 */
export async function resolveHandles(
  args: Record<string, unknown>,
  open: ResultOpener,
  { skip = [] }: { skip?: string[] } = {},
): Promise<Record<string, unknown>> {
  const searched = Object.fromEntries(
    Object.entries(args).filter(([key]) => !skip.includes(key)),
  )
  const ids = collectHandleIds(searched)

  if (ids.length === 0) {
    return args
  }

  const opened = new Map<string, OpenedResult>()

  for (const id of ids) {
    const result = await open(id)

    if (!result) {
      throw invalid(missingResultMessage(id))
    }

    opened.set(id, result)
  }

  let chars = 0
  const walk: Walk = { nodes: 0 }

  const replace = (value: unknown, depth: number): unknown => {
    step(walk, depth)

    const handle = parseHandle(value)

    if (handle) {
      const content = contentOf(opened.get(handle.$result)!, handle.as)
      chars += content.length

      if (chars > MAX_RESOLVED_CHARS) {
        throw invalid(
          `The kept results in these arguments add up to more than ${MAX_RESOLVED_CHARS.toLocaleString("en")} characters, more than PCP passes on in one call.`,
        )
      }

      return content
    }

    if (Array.isArray(value)) {
      return value.map((item) => replace(item, depth + 1))
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          replace(item, depth + 1),
        ]),
      )
    }

    return value
  }

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      skip.includes(key) ? value : replace(value, 0),
    ]),
  )
}
