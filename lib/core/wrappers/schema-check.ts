import {
  MAX_OUTPUT_CHECK_DEPTH,
  MAX_OUTPUT_CHECK_NODES,
  MAX_OUTPUT_SCHEMA_NODES,
} from "./limits"

/**
 * A small JSON Schema check for what a wrapper tool returns: its shape, not
 * its details. It follows `type`, `enum`, `const`, `required`, `properties`,
 * `additionalProperties`, `items`, `anyOf`, `oneOf` and `allOf`; formats,
 * ranges, lengths and patterns are not checked. It is written out rather
 * than a validator library's because a schema comes from an assistant, and a
 * library that compiles schemas to code would run it. References are not
 * followed (`hasReference` refuses them when the schema is saved), and the
 * walk is bounded by values and depth.
 */

type Json = Record<string, unknown>

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
}

class TooLarge extends Error {}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function kindOf(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value
}

function where(at: string): string {
  return at === "" ? "The answer" : `"${at}"`
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Whether a schema has a $ref anywhere in it, or is too big to look through. */
export function hasReference(schema: unknown): boolean {
  const stack: unknown[] = [schema]
  let nodes = 0

  while (stack.length > 0) {
    const node = stack.pop()

    if (++nodes > MAX_OUTPUT_SCHEMA_NODES) {
      return true
    }

    if (Array.isArray(node)) {
      stack.push(...node)
    } else if (isRecord(node)) {
      if ("$ref" in node || "$dynamicRef" in node) {
        return true
      }

      stack.push(...Object.values(node))
    }
  }

  return false
}

function visit(
  schema: unknown,
  value: unknown,
  at: string,
  depth: number,
  walk: { nodes: number },
): string | null {
  if (--walk.nodes < 0) {
    throw new TooLarge()
  }

  if (schema === false) {
    return `${where(at)} is not allowed by the outputSchema.`
  }

  if (!isRecord(schema)) {
    return null
  }

  if (depth > MAX_OUTPUT_CHECK_DEPTH) {
    return `${where(at)} is nested more than ${MAX_OUTPUT_CHECK_DEPTH} levels deep, more than an outputSchema is checked to.`
  }

  const type = schema.type
  const types = (Array.isArray(type) ? type : [type]).filter(
    (entry): entry is string => typeof entry === "string",
  )

  if (
    types.length > 0 &&
    !types.some((entry) => TYPES[entry]?.(value) ?? true)
  ) {
    return `${where(at)} is ${kindOf(value)}, but the outputSchema says ${types.join(" or ")}.`
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((o) => same(o, value))) {
    return `${where(at)} is not one of the outputSchema's enum values.`
  }

  if ("const" in schema && !same(schema.const, value)) {
    return `${where(at)} is not the outputSchema's const.`
  }

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const options = schema[key]

    if (!Array.isArray(options) || options.length === 0) {
      continue
    }

    const problems = options.map((option) =>
      visit(option, value, at, depth + 1, walk),
    )
    const matching = problems.filter((problem) => problem === null).length

    if (key === "allOf") {
      const first = problems.find((problem) => problem !== null)

      if (first) {
        return first
      }
    } else if (matching === 0) {
      return `${where(at)} matches none of the outputSchema's ${key} options (the first says: ${problems[0]!.replace(/\.$/, "")}).`
    } else if (key === "oneOf" && matching > 1) {
      return `${where(at)} matches more than one of the outputSchema's oneOf options.`
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const problem = visit(
        schema.items,
        item,
        `${at}/${index}`,
        depth + 1,
        walk,
      )

      if (problem) {
        return problem
      }
    }
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : []

    for (const name of required) {
      if (typeof name === "string" && !Object.hasOwn(value, name)) {
        return `${where(at)} has no "${name}", which the outputSchema requires.`
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {}

    for (const [name, item] of Object.entries(value)) {
      const child = `${at}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`

      if (Object.hasOwn(properties, name)) {
        const problem = visit(properties[name], item, child, depth + 1, walk)

        if (problem) {
          return problem
        }
      } else if (schema.additionalProperties === false) {
        return `${where(at)} has "${name}", which the outputSchema does not list (it allows only: ${Object.keys(properties).slice(0, 30).join(", ") || "(none)"}).`
      } else if (isRecord(schema.additionalProperties)) {
        const problem = visit(
          schema.additionalProperties,
          item,
          child,
          depth + 1,
          walk,
        )

        if (problem) {
          return problem
        }
      }
    }
  }

  return null
}

/** What is wrong with a value against its schema, or null when it fits. */
export function checkValue(schema: unknown, value: unknown): string | null {
  try {
    return visit(schema, value, "", 0, { nodes: MAX_OUTPUT_CHECK_NODES })
  } catch (error) {
    if (error instanceof TooLarge) {
      return `The answer has more than ${MAX_OUTPUT_CHECK_NODES.toLocaleString("en")} values, more than an outputSchema is checked against. Return less.`
    }

    throw error
  }
}
