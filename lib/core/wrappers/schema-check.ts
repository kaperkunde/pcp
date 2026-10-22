import {
  MAX_OUTPUT_CHECK_DEPTH,
  MAX_OUTPUT_CHECK_NODES,
  MAX_OUTPUT_SCHEMA_NODES,
} from "./limits"

/**
 * A small JSON Schema check for what a wrapper tool returns, and for the
 * arguments of a call before it runs or asks the owner: its shape, not
 * its details. It follows `type`, `enum`, `const`, `required`, `properties`,
 * `additionalProperties`, `items`, `anyOf`, `oneOf` and `allOf`; formats,
 * ranges, lengths and patterns are not checked. It is written out rather
 * than a validator library's because a schema comes from an assistant, and a
 * library that compiles schemas to code would run it. References are not
 * followed (`hasReference` refuses them when an outputSchema is saved), and
 * the walk is bounded by values and depth.
 *
 * Arguments are checked against a schema PCP did not write (an MCP
 * server's, an API's), so that check gives the benefit of the doubt: a part
 * it cannot evaluate (a $ref, patternProperties) passes, OpenAPI's
 * `nullable` is honoured, oneOf counts as anyOf (what tells its options
 * apart may be a pattern it does not check), and a kept result's handle
 * stands for whatever goes there.
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

type Walk = {
  nodes: number
  /** What the value is called as a whole. */
  whole: string
  /** What the schema is called. */
  schema: string
  /** Checking a call's arguments: the lenient rules above. */
  args: boolean
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function kindOf(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value
}

function where(at: string, walk: Walk): string {
  return at === "" ? walk.whole : `"${walk.args ? at.slice(1) : at}"`
}

/** A kept result in a call's arguments, or a file named by one. */
function isResultReference(value: unknown): boolean {
  return isRecord(value) && typeof value.$result === "string"
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
  walk: Walk,
): string | null {
  if (--walk.nodes < 0) {
    throw new TooLarge()
  }

  if (schema === false) {
    return `${where(at, walk)} is not allowed by the ${walk.schema}.`
  }

  if (!isRecord(schema)) {
    return null
  }

  if (walk.args) {
    if (
      "$ref" in schema ||
      "$dynamicRef" in schema ||
      isResultReference(value) ||
      (value === null && schema.nullable === true) ||
      depth > MAX_OUTPUT_CHECK_DEPTH
    ) {
      return null
    }
  } else if (depth > MAX_OUTPUT_CHECK_DEPTH) {
    return `${where(at, walk)} is nested more than ${MAX_OUTPUT_CHECK_DEPTH} levels deep, more than an outputSchema is checked to.`
  }

  const type = schema.type
  const types = (Array.isArray(type) ? type : [type]).filter(
    (entry): entry is string => typeof entry === "string",
  )

  if (
    types.length > 0 &&
    !types.some((entry) => TYPES[entry]?.(value) ?? true)
  ) {
    return `${where(at, walk)} is ${kindOf(value)}, but the ${walk.schema} says ${types.join(" or ")}.`
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((o) => same(o, value))) {
    return `${where(at, walk)} is not one of the ${walk.schema}'s enum values${
      walk.args
        ? ` (${schema.enum
            .slice(0, 20)
            .map((option) => JSON.stringify(option))
            .join(", ")})`
        : ""
    }.`
  }

  if ("const" in schema && !same(schema.const, value)) {
    return `${where(at, walk)} is not the ${walk.schema}'s const.`
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
      return `${where(at, walk)} matches none of the ${walk.schema}'s ${key} options (the first says: ${problems[0]!.replace(/\.$/, "")}).`
    } else if (key === "oneOf" && matching > 1 && !walk.args) {
      return `${where(at, walk)} matches more than one of the ${walk.schema}'s oneOf options.`
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
        return `${where(at, walk)} has no "${name}", which the ${walk.schema} requires.`
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
      } else if (
        walk.args &&
        ("patternProperties" in schema || "unevaluatedProperties" in schema)
      ) {
        // Which names those allow is more than this check reads.
      } else if (schema.additionalProperties === false) {
        return `${where(at, walk)} has "${name}", which the ${walk.schema} does not list (it allows only: ${Object.keys(properties).slice(0, 30).join(", ") || "(none)"}).`
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
    return visit(schema, value, "", 0, {
      nodes: MAX_OUTPUT_CHECK_NODES,
      whole: "The answer",
      schema: "outputSchema",
      args: false,
    })
  } catch (error) {
    if (error instanceof TooLarge) {
      return `The answer has more than ${MAX_OUTPUT_CHECK_NODES.toLocaleString("en")} values, more than an outputSchema is checked against. Return less.`
    }

    throw error
  }
}

/** At most this many problems are named for one call's arguments. */
const MAX_ARGUMENT_PROBLEMS = 10

/**
 * What is wrong with a call's arguments against the tool's inputSchema, one
 * line per problem: empty when they fit, or when there is too much to look
 * through (the tool then decides). Lenient where the schema says more than
 * this check reads (see above).
 */
export function checkArguments(
  schema: unknown,
  args: Record<string, unknown>,
): string[] {
  if (!isRecord(schema) || "$ref" in schema || "$dynamicRef" in schema) {
    return []
  }

  const walk: Walk = {
    nodes: MAX_OUTPUT_CHECK_NODES,
    whole: "The arguments",
    schema: "inputSchema",
    args: true,
  }
  const problems: string[] = []
  const open =
    "patternProperties" in schema || "unevaluatedProperties" in schema

  try {
    // The top level one argument at a time, so every wrong one is named at
    // once rather than one per round trip.
    const required = Array.isArray(schema.required) ? schema.required : []

    for (const name of required) {
      if (typeof name === "string" && !Object.hasOwn(args, name)) {
        problems.push(`"${name}" is missing; the inputSchema requires it.`)
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {}
    const listed = Object.keys(properties)

    for (const [name, value] of Object.entries(args)) {
      const at = `/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`

      if (Object.hasOwn(properties, name)) {
        const problem = visit(properties[name], value, at, 1, walk)

        if (problem) {
          problems.push(problem)
        }
      } else if (schema.additionalProperties === false && !open) {
        problems.push(
          `"${name}" is not an argument of this tool (it takes: ${listed.slice(0, 30).join(", ") || "none"}).`,
        )
      } else if (isRecord(schema.additionalProperties) && !open) {
        const problem = visit(schema.additionalProperties, value, at, 1, walk)

        if (problem) {
          problems.push(problem)
        }
      }
    }

    // What the top level says besides (its type, anyOf and the like).
    if (problems.length === 0) {
      const whole = visit(
        {
          ...schema,
          properties: undefined,
          required: undefined,
          additionalProperties: undefined,
        },
        args,
        "",
        0,
        walk,
      )

      if (whole) {
        problems.push(whole)
      }
    }
  } catch (error) {
    if (error instanceof TooLarge) {
      return []
    }

    throw error
  }

  return problems.slice(0, MAX_ARGUMENT_PROBLEMS)
}
