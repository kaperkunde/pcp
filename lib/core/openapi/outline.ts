import { entries, isObject, own, ownString, type JsonObject } from "./json"
import {
  MAX_OUTLINE_CHARS,
  MAX_OUTLINE_PROPERTIES,
  OUTLINE_MAX_NODES,
} from "./limits"
import { resolvePointer } from "./refs"

/**
 * What a successful call answers, as a short outline an assistant can read
 * before it calls: `{data: [{id: string, amount: number, …}], meta: {…}}`.
 * Text the API sends base64-encoded is `string (base64)`.
 * describe_tool shows it, so the assistant knows the field names to look
 * for, and to pick with call_tool's fields, without a first call to find out.
 *
 * Read from the schema's own description of the answer, which is untrusted
 * like the rest of it: only local references are followed, a reference back
 * into itself stops, and the walk and the text are both bounded.
 */

type Walk = { nodes: number; seen: Set<string> }

/** The success answer's JSON schema, or undefined when it declares none. */
function answerSchema(doc: unknown, operation: JsonObject): unknown {
  const responses = entries(own(operation, "responses"))
  const success = [
    ...responses.filter(([status]) => /^2(\d\d|XX)$/i.test(status)),
    ...responses.filter(([status]) => status === "default"),
  ]

  for (const [, raw] of success) {
    const response = follow(doc, raw, new Set())
    const json = entries(own(response, "content")).find(([type]) =>
      /^application\/([\w.+-]+\+)?json\b/i.test(type),
    )
    const schema = json ? own(json[1], "schema") : undefined

    if (schema !== undefined) {
      return schema
    }
  }

  return undefined
}

/** A node with its local $ref followed, or undefined when it cannot be. */
function follow(doc: unknown, node: unknown, seen: Set<string>): unknown {
  let current = node

  for (let hops = 0; hops < 10; hops++) {
    const ref = ownString(current, "$ref")

    if (ref === undefined) {
      return current
    }

    if (seen.has(ref)) {
      return undefined
    }

    try {
      current = resolvePointer(doc, ref)
    } catch {
      return undefined
    }
  }

  return undefined
}

function typeWord(schema: JsonObject): string {
  const choices = own(schema, "enum")

  if (
    Array.isArray(choices) &&
    choices.length > 0 &&
    choices.length <= 6 &&
    choices.every(
      (choice) =>
        (typeof choice === "string" && choice.length <= 20) ||
        typeof choice === "number" ||
        typeof choice === "boolean",
    )
  ) {
    return choices.map((choice) => JSON.stringify(choice)).join(" | ")
  }

  const type = own(schema, "type")
  const named = Array.isArray(type)
    ? type.filter((entry) => typeof entry === "string").join(" | ")
    : typeof type === "string"
      ? type
      : ""

  // Text the API encodes, so an assistant knows to decode it (call_tool's
  // decode) or to leave it out.
  if (
    named === "string" &&
    (own(schema, "format") === "byte" ||
      own(schema, "contentEncoding") === "base64")
  ) {
    return "string (base64)"
  }

  return named || "any"
}

function outline(
  doc: unknown,
  node: unknown,
  depth: number,
  walk: Walk,
): string {
  walk.nodes -= 1

  if (walk.nodes < 0) {
    return "…"
  }

  const ref = ownString(node, "$ref")
  const schema = follow(doc, node, walk.seen)

  if (!isObject(schema)) {
    return ref ? "{…}" : "any"
  }

  // A reference is open while its own contents are outlined, so one back
  // into itself (a tree of comments) stops instead of going round.
  if (ref) {
    walk.seen.add(ref)
  }

  try {
    const allOf = own(schema, "allOf")
    if (Array.isArray(allOf) && allOf.length > 0) {
      const merged = mergeAllOf(doc, schema, allOf, walk)
      return objectOutline(doc, merged, depth, walk)
    }

    for (const key of ["oneOf", "anyOf"]) {
      const options = own(schema, key)
      if (Array.isArray(options) && options.length > 0) {
        const shown = options
          .slice(0, 3)
          .map((option) => outline(doc, option, depth, walk))
        return `${shown.join(" | ")}${options.length > 3 ? " | …" : ""}`
      }
    }

    const items = own(schema, "items")
    if (own(schema, "type") === "array" || items !== undefined) {
      return `[${items === undefined ? "any" : outline(doc, items, depth, walk)}]`
    }

    if (isObject(own(schema, "properties"))) {
      return objectOutline(doc, schema, depth, walk)
    }

    return typeWord(schema)
  } finally {
    if (ref) {
      walk.seen.delete(ref)
    }
  }
}

/** allOf's parts as one object: the properties of each, in order. */
function mergeAllOf(
  doc: unknown,
  schema: JsonObject,
  parts: unknown[],
  walk: Walk,
): JsonObject {
  const properties: JsonObject = {}

  for (const part of [schema, ...parts.slice(0, 10)]) {
    const resolved = follow(doc, part, walk.seen)
    for (const [name, child] of entries(own(resolved, "properties"))) {
      properties[name] = child
    }
  }

  return { type: "object", properties }
}

function objectOutline(
  doc: unknown,
  schema: JsonObject,
  depth: number,
  walk: Walk,
): string {
  const properties = entries(own(schema, "properties"))

  if (properties.length === 0) {
    return "{}"
  }

  if (depth <= 0) {
    return "{…}"
  }

  const shown = properties
    .slice(0, MAX_OUTLINE_PROPERTIES)
    .map(([name, child]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
      return `${key.slice(0, 100)}: ${outline(doc, child, depth - 1, walk)}`
    })
  const more = properties.length - shown.length

  return `{${shown.join(", ")}${more > 0 ? `, … ${more} more` : ""}}`
}

/**
 * The outline of what an operation answers when it succeeds, or null when
 * its schema does not say. As deep as fits in MAX_OUTLINE_CHARS.
 */
export function outlineAnswer(
  doc: unknown,
  operation: JsonObject,
): string | null {
  const schema = answerSchema(doc, operation)

  if (schema === undefined) {
    return null
  }

  for (const depth of [4, 3, 2, 1]) {
    const text = outline(doc, schema, depth, {
      nodes: OUTLINE_MAX_NODES,
      seen: new Set(),
    })

    if (text.length <= MAX_OUTLINE_CHARS) {
      return text === "any" ? null : text
    }
  }

  return null
}
