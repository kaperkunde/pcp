import { invalid } from "../errors"
import { isObject, type JsonObject } from "./json"
import {
  MAX_PATCH_CHARS,
  MAX_PATCH_OPERATIONS,
  MAX_POINTER_LENGTH,
  MAX_SPEC_NODES,
} from "./limits"
import { countNodes } from "./parse"

/**
 * An endpoint's edits: JSON Patch operations (RFC 6902) applied to its
 * schema every time tools are generated from it, so a schema can be fixed or
 * narrowed without sending the whole document again, and a schema read from
 * a URL keeps its fixes when it is read again.
 *
 * Edits are untrusted input like the schema itself. Keys are set as own
 * properties and "__proto__" is refused, so no edit reaches a prototype; and
 * what edits add counts against the same node limit as a parsed schema, so
 * copying a large part over and over fails instead of filling memory.
 */

export type PatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string }

const OPS = new Set(["add", "remove", "replace", "move", "copy", "test"])
const INDEX = /^(0|[1-9]\d*)$/

/** A JSON Pointer (RFC 6901) as its unescaped tokens. */
export function parsePointer(pointer: string): string[] {
  if (pointer.length > MAX_POINTER_LENGTH) {
    throw invalid(
      `The pointer is longer than ${MAX_POINTER_LENGTH} characters.`,
    )
  }

  if (pointer === "") {
    return []
  }

  if (!pointer.startsWith("/")) {
    throw invalid(
      `"${pointer.slice(0, 80)}" is not a JSON Pointer: it starts with "/" (or is "" for the whole document).`,
    )
  }

  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~[^01]|~$/.test(token)) {
        throw invalid(
          `"${pointer.slice(0, 80)}" has a "~" that is not ~0 or ~1.`,
        )
      }

      const key = token.replace(/~1/g, "/").replace(/~0/g, "~")

      if (key === "__proto__") {
        throw invalid("A pointer cannot name __proto__.")
      }

      return key
    })
}

/**
 * Checks edits as given (by an assistant, or read back from the database)
 * and returns them with only the fields each operation uses.
 */
export function readPatches(input: unknown): PatchOperation[] {
  if (!Array.isArray(input)) {
    throw invalid("Edits are a JSON Patch: a list of operations.")
  }

  if (input.length > MAX_PATCH_OPERATIONS) {
    throw invalid(
      `That is ${input.length} edits; an endpoint keeps at most ${MAX_PATCH_OPERATIONS}.`,
    )
  }

  if (JSON.stringify(input).length > MAX_PATCH_CHARS) {
    throw invalid(
      `The edits come to more than ${MAX_PATCH_CHARS} characters as JSON.`,
    )
  }

  return input.map((raw, index) => {
    const label = `Edit ${index + 1}`

    if (!isObject(raw)) {
      throw invalid(`${label} is not an object like {"op", "path", ...}.`)
    }

    const op = raw.op
    const path = raw.path

    if (typeof op !== "string" || !OPS.has(op)) {
      throw invalid(
        `${label}: op is one of add, remove, replace, move, copy, test.`,
      )
    }

    if (typeof path !== "string") {
      throw invalid(`${label}: path is a JSON Pointer, like /paths/~1pets.`)
    }

    withLabel(label, () => parsePointer(path))

    if (op === "move" || op === "copy") {
      if (typeof raw.from !== "string") {
        throw invalid(`${label}: ${op} needs from, a JSON Pointer.`)
      }

      withLabel(label, () => parsePointer(raw.from as string))
      return { op, from: raw.from, path }
    }

    if (op === "remove") {
      return { op, path }
    }

    if (!Object.hasOwn(raw, "value") || raw.value === undefined) {
      throw invalid(`${label}: ${op} needs a value.`)
    }

    return { op: op as "add" | "replace" | "test", path, value: raw.value }
  })
}

/** Reads the stored form, checked again like anything else read back. */
export function readStoredPatches(
  json: string | null | undefined,
): PatchOperation[] {
  if (!json) {
    return []
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(json)
  } catch {
    throw invalid("The endpoint's stored edits are not JSON.")
  }

  return readPatches(parsed)
}

function withLabel<T>(label: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${label}: ${error.message}`
    }
    throw error
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function set(container: JsonObject, key: string, value: unknown) {
  Object.defineProperty(container, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function child(container: unknown, key: string): unknown {
  if (Array.isArray(container)) {
    return INDEX.test(key) && Number(key) < container.length
      ? container[Number(key)]
      : undefined
  }

  return isObject(container) && Object.hasOwn(container, key)
    ? container[key]
    : undefined
}

function show(tokens: string[]): string {
  return tokens.length === 0
    ? '""'
    : `/${tokens.map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
}

/** The value a pointer names, or undefined when there is none. */
export function valueAt(root: unknown, pointer: string): unknown {
  let current = root

  for (const token of parsePointer(pointer)) {
    current = child(current, token)

    if (current === undefined) {
      return undefined
    }
  }

  return current
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equal(item, b[i]))
  }

  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    )
  }

  return false
}

/**
 * The document with the edits applied, in order. The document given is not
 * changed. An edit that does not apply (a path that is not there, a test
 * that fails) throws, naming the edit, and nothing is applied.
 */
export function applyPatches(
  document: unknown,
  patches: PatchOperation[],
): unknown {
  if (patches.length === 0) {
    return document
  }

  // A copy, which also turns any shared YAML alias into its own value, so
  // an edit at one place does not show up at another.
  const box = { root: clone(document) }
  let nodes = countNodes(box.root, MAX_SPEC_NODES)

  const grow = (value: unknown) => {
    nodes += countNodes(value, MAX_SPEC_NODES - nodes + 1)

    if (nodes > MAX_SPEC_NODES) {
      throw invalid("the schema would be too large with it.")
    }
  }

  const parentOf = (tokens: string[]) => {
    let current: unknown = box.root

    for (let i = 0; i < tokens.length - 1; i++) {
      current = child(current, tokens[i])

      if (current === undefined) {
        throw invalid(`there is nothing at ${show(tokens.slice(0, i + 1))}.`)
      }
    }

    if (!Array.isArray(current) && !isObject(current)) {
      throw invalid(`${show(tokens.slice(0, -1))} is not an object or a list.`)
    }

    return current
  }

  const get = (tokens: string[]): unknown => {
    let current: unknown = box.root

    for (let i = 0; i < tokens.length; i++) {
      current = child(current, tokens[i])

      if (current === undefined) {
        throw invalid(`there is nothing at ${show(tokens.slice(0, i + 1))}.`)
      }
    }

    return current
  }

  const add = (tokens: string[], value: unknown) => {
    if (tokens.length === 0) {
      box.root = value
      return
    }

    const parent = parentOf(tokens)
    const key = tokens[tokens.length - 1]

    if (Array.isArray(parent)) {
      if (key === "-") {
        parent.push(value)
        return
      }

      if (!INDEX.test(key) || Number(key) > parent.length) {
        throw invalid(
          `${key} is not a position in the list at ${show(tokens.slice(0, -1))} (it has ${parent.length}; "-" adds at the end).`,
        )
      }

      parent.splice(Number(key), 0, value)
      return
    }

    set(parent, key, value)
  }

  const remove = (tokens: string[]): unknown => {
    if (tokens.length === 0) {
      throw invalid("the whole document cannot be removed.")
    }

    const removed = get(tokens)
    const parent = parentOf(tokens)
    const key = tokens[tokens.length - 1]

    if (Array.isArray(parent)) {
      parent.splice(Number(key), 1)
    } else {
      delete parent[key]
    }

    return removed
  }

  const replace = (tokens: string[], value: unknown) => {
    get(tokens)

    if (tokens.length === 0) {
      box.root = value
      return
    }

    const parent = parentOf(tokens)
    const key = tokens[tokens.length - 1]

    if (Array.isArray(parent)) {
      parent[Number(key)] = value
    } else {
      set(parent, key, value)
    }
  }

  patches.forEach((patch, index) => {
    withLabel(`Edit ${index + 1} (${patch.op} ${patch.path})`, () => {
      const tokens = parsePointer(patch.path)

      switch (patch.op) {
        case "add": {
          const value = clone(patch.value)
          grow(value)
          add(tokens, value)
          break
        }
        case "replace": {
          const value = clone(patch.value)
          grow(value)
          replace(tokens, value)
          break
        }
        case "remove":
          remove(tokens)
          break
        case "test":
          if (!equal(get(tokens), patch.value)) {
            throw invalid("the value there is not the one the test expects.")
          }
          break
        case "move": {
          const from = parsePointer(patch.from)

          if (
            from.length < tokens.length &&
            from.every((token, i) => token === tokens[i])
          ) {
            throw invalid("a value cannot be moved into itself.")
          }

          add(tokens, remove(from))
          break
        }
        case "copy": {
          const value = clone(get(parsePointer(patch.from)))
          grow(value)
          add(tokens, value)
          break
        }
      }
    })
  })

  return box.root
}
