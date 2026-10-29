import type {
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server"
import { z } from "zod"

import type { Outcome } from "./outcome"
import type { InvalidHint } from "./validate"

/**
 * The one interface every tool PCP exposes is written to: PCP's own tools at
 * /mcp (gateway.ts), and in time every family behind call_tool.
 *
 *   defineTool({ name, title, description, input, output?, annotations,
 *                aliases?, log?, quiet?, invalidHint?, run })
 *
 * - `name`: 1 to 128 of A-Z, a-z, 0-9, _, . and -, as MCP names go.
 * - `input`: a zod object. It is published as JSON Schema 2020-12 (no
 *   `$schema`, the dialect MCP assumes), every object in it closed with
 *   additionalProperties: false, and every property must carry a
 *   description: the schema is all an assistant reads about an argument,
 *   so a property without one is refused when the schema is first made.
 *   Arguments are checked against that same JSON Schema by validate.ts, in
 *   PCP's words, inside the call, so a refusal reaches the request log; an
 *   unknown key is an error that names it and the keys the tool takes,
 *   never dropped. A no-argument tool is z.object({}):
 *   {"type": "object", "additionalProperties": false}.
 * - `output`: declared when every successful answer is one JSON shape (a
 *   union of shapes is one): run's ok(value) is then structuredContent and
 *   its JSON the text, and a tool that can wait for the owner lists
 *   NEEDS_OWNER (outcome.ts) among its shapes. A tool that answers in
 *   prose, or passes on another tool's answer (call_tool, run_code), has
 *   no output schema and answers text; if it waits for the owner, its
 *   result still carries NEEDS_OWNER as structuredContent.
 * - `annotations`: all four hints, always, since MCP's defaults (not read
 *   only, destructive, not idempotent, open world) are rarely right.
 *   A proposal that only asks the owner (it writes nothing until they agree,
 *   and each call is a new request) is not destructive and not idempotent.
 * - `aliases`: old argument names, accepted for one release. A key is an
 *   argument's old name ("addPatches") or a path to one inside a list
 *   ("tools[].inputSchema"); its value the new name ("add_patches"). The old
 *   name is renamed before the arguments are checked, and the answer starts
 *   with "addPatches was renamed to add_patches; use add_patches."
 *   (docs/breaking-changes.md lists them).
 * - `log`: the server and upstream tool for the request log, from the
 *   arguments as sent; never anything else of them. `quiet`: its refusals
 *   quote what was sent (a memory's path), so the log keeps only that it
 *   failed.
 * - `invalidHint`: what to add to a refusal of arguments that do not fit.
 * - `run(args, ctx)`: the arguments checked and parsed by `input`, and
 *   the outcome (outcome.ts). A thrown PcpError is a toolError with its
 *   code; anything else thrown is PCP's fault, logged on the server.
 */

export type ToolAnnotations = {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** What a call's line in the request log names besides the tool. */
export type LogNames = { server?: string; upstreamTool?: string }

export type ToolContext = {
  /** Aborts when the client goes away. */
  signal: AbortSignal
  /** The SDK's own context, for progress notifications. */
  request: ServerContext
  /** Names the call's server and upstream tool once it knows them. */
  logAs: (names: LogNames) => void
}

type Json = Record<string, unknown>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = z.ZodObject<any>

export type ToolSpec<I extends AnyObject = AnyObject> = {
  name: string
  title: string
  description: string
  input: I
  output?: z.ZodType
  annotations: ToolAnnotations
  aliases?: Record<string, string>
  log?: (args: Record<string, unknown>) => LogNames
  quiet?: boolean
  invalidHint?: InvalidHint
  // A method, so a run may name its arguments' type as it reads them.
  run(args: z.output<I>, ctx: ToolContext): Promise<Outcome>
}

export type Tool = ToolSpec & {
  /** The input schema as published, made and checked on first use. */
  inputSchema(): Json
  /** The output schema as published, when the tool declares one. */
  outputSchema(): Json | undefined
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** Number.MAX_SAFE_INTEGER bounds zod adds to every integer: noise. */
const SAFE_BOUND = Number.MAX_SAFE_INTEGER

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Every schema directly inside one, with the path that leads to it. */
function children(schema: Json, at: string): Array<[Json, string]> {
  const found: Array<[Json, string]> = []
  const push = (value: unknown, path: string) => {
    if (isRecord(value)) {
      found.push([value, path])
    }
  }

  if (isRecord(schema.properties)) {
    for (const [name, value] of Object.entries(schema.properties)) {
      push(value, `${at}/${name}`)
    }
  }

  for (const key of ["items", "additionalProperties", "not", "contains"]) {
    push(schema[key], `${at}/${key === "items" ? "[]" : key}`)
  }

  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = schema[key]

    if (Array.isArray(list)) {
      list.forEach((value, index) => push(value, `${at}/${key}/${index}`))
    }
  }

  for (const key of ["$defs", "definitions", "patternProperties"]) {
    const map = schema[key]

    if (isRecord(map)) {
      for (const [name, value] of Object.entries(map)) {
        push(value, `${at}/${key}/${name}`)
      }
    }
  }

  return found
}

/**
 * Closes every object an input schema describes (additionalProperties:
 * false where it says nothing), and drops what says nothing: zod's safe
 * integer bounds and a no-argument tool's empty properties.
 */
function tidyInput(schema: Json, root: boolean): void {
  if (schema.maximum === SAFE_BOUND) delete schema.maximum
  if (schema.minimum === -SAFE_BOUND) delete schema.minimum

  if (
    (schema.type === "object" || isRecord(schema.properties)) &&
    schema.additionalProperties === undefined &&
    schema.patternProperties === undefined
  ) {
    schema.additionalProperties = false
  }

  if (
    root &&
    isRecord(schema.properties) &&
    Object.keys(schema.properties).length === 0
  ) {
    delete schema.properties
  }

  for (const [child] of children(schema, "")) {
    tidyInput(child, false)
  }
}

/** The properties of an input schema that have no description, by path. */
export function undescribedProperties(schema: Json, at = ""): string[] {
  const missing: string[] = []

  if (isRecord(schema.properties)) {
    for (const [name, value] of Object.entries(schema.properties)) {
      const described =
        isRecord(value) &&
        typeof value.description === "string" &&
        value.description.trim() !== ""

      if (!described) {
        missing.push(`${at}/${name}`)
      }
    }
  }

  for (const [child, path] of children(schema, at)) {
    missing.push(...undescribedProperties(child, path))
  }

  return missing
}

/** A zod schema as the JSON Schema a tool publishes. */
export function toolJsonSchema(
  schema: z.ZodType,
  io: "input" | "output",
): Json {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as Json

  delete json.$schema

  if (io === "input") {
    tidyInput(json, true)
  } else if (json.type === undefined) {
    // An output that is a union of objects is an object (MCP's 2025 wire
    // shape needs that at the root to carry it unwrapped).
    json.type = "object"
  }

  return json
}

/**
 * A schema for the SDK: it publishes the JSON Schema given and lets every
 * value through, since serve.ts checks the arguments itself, in PCP's words
 * and inside the call's log line.
 */
export function publishedSchema(
  json: () => Json,
): StandardSchemaWithJSON<Json, Json> {
  return {
    "~standard": {
      version: 1,
      vendor: "pcp",
      validate: (value) => ({ value: (isRecord(value) ? value : {}) as Json }),
      jsonSchema: { input: () => json(), output: () => json() },
    },
  }
}

/** The name MCP allows a tool, or why not. */
export function checkToolName(name: string): void {
  if (!TOOL_NAME.test(name)) {
    throw new Error(
      `A tool's name is 1 to 128 letters, digits, "_", "." or "-": ${JSON.stringify(name)} is not.`,
    )
  }
}

/** Whether a name is one MCP allows a tool (1 to 128 of A-Z a-z 0-9 _ . -). */
export function isToolName(name: string): boolean {
  return TOOL_NAME.test(name)
}

/**
 * A tool's input and output schemas as published, made and checked on
 * first use: every property described, the input an object.
 */
export function toolSchemas(
  name: string,
  inputType: AnyObject,
  outputType: z.ZodType | undefined,
): { inputSchema(): Json; outputSchema(): Json | undefined } {
  let input: Json | undefined
  let output: Json | undefined

  return {
    inputSchema() {
      if (!input) {
        const json = toolJsonSchema(inputType, "input")
        const missing = undescribedProperties(json)

        if (missing.length > 0) {
          throw new Error(
            `${name}'s input schema has properties without a description: ${missing.join(", ")}.`,
          )
        }

        if (json.type !== "object") {
          throw new Error(`${name}'s input schema is not an object.`)
        }

        input = json
      }

      return input
    },
    outputSchema() {
      if (outputType && !output) {
        output = toolJsonSchema(outputType, "output")
      }

      return output
    },
  }
}

export function defineTool<I extends AnyObject>(spec: ToolSpec<I>): Tool {
  checkToolName(spec.name)

  return {
    ...(spec as unknown as ToolSpec),
    ...toolSchemas(spec.name, spec.input, spec.output),
  }
}

export type AliasResult = {
  args: Record<string, unknown>
  /** "x was renamed to y; use y." for each old name used. */
  notes: string[]
  /** Both names given: what to say instead of running. */
  conflict?: string
}

function renameIn(
  node: unknown,
  segments: string[],
  to: string,
  path: string,
  result: AliasResult,
): void {
  const [head, ...rest] = segments

  if (head === undefined || !isRecord(node)) {
    return
  }

  if (rest.length === 0) {
    if (!Object.hasOwn(node, head)) {
      return
    }

    const note = `${path}${head} was renamed to ${to}; use ${to}.`

    if (Object.hasOwn(node, to)) {
      result.conflict ??= `${path}${head} was renamed to ${to}: pass only ${to}.`
      return
    }

    node[to] = node[head]
    delete node[head]

    if (!result.notes.includes(note)) {
      result.notes.push(note)
    }

    return
  }

  const list = head.endsWith("[]")
  const key = list ? head.slice(0, -2) : head
  const next = node[key]

  if (list && Array.isArray(next)) {
    for (const item of next) {
      renameIn(item, rest, to, `${path}${key}[].`, result)
    }
  } else if (!list) {
    renameIn(next, rest, to, `${path}${key}.`, result)
  }
}

/**
 * The arguments with old names renamed (a copy: what the client sent is
 * left as it is), and a note for each.
 */
export function applyAliases(
  args: Record<string, unknown>,
  aliases: Record<string, string> | undefined,
): AliasResult {
  if (!aliases || Object.keys(aliases).length === 0) {
    return { args, notes: [] }
  }

  const result: AliasResult = {
    args: structuredClone(args),
    notes: [],
  }

  for (const [from, to] of Object.entries(aliases)) {
    renameIn(result.args, from.split("."), to, "", result)
  }

  return result
}
