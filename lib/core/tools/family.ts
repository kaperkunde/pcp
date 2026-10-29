import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import { isPcpError } from "../errors"
import {
  applyAliases,
  checkToolName,
  toolSchemas,
  type ToolAnnotations,
} from "./define"
import { ok, toCallToolResult, toolError, type ToolErrorCode } from "./outcome"
import {
  argumentsRefusal,
  validate,
  zodProblems,
  type ValidateOptions,
} from "./validate"

/**
 * The tools of PCP's own families behind call_tool (the browser, mail and
 * calendar accounts, SSH servers, services), defined through the same
 * interface as PCP's own tools at /mcp (define.ts) and checked by the same
 * validator:
 *
 *   defineInnerTool({ name, title, description, input, output?,
 *                     annotations, aliases?, retired?, rules? })
 *
 * They are not served at /mcp: the gateway reaches them through call_tool
 * and run_code, a wrapper's program through its calls, and each family runs
 * them with what it holds (a credential, a tab). So an inner tool has no
 * `run`; it publishes its schemas for the catalogue and checks a call's
 * arguments (`check`), which every way in calls before anything connects or
 * the owner is asked (lib/core/call-arguments.ts), and the family once
 * more before it runs.
 *
 * - `input`: a zod object, published as JSON Schema 2020-12 like a gateway
 *   tool's, every object closed and every property described.
 * - `rules`: what holds across arguments ("a ref or a target, one of
 *   them"), each as JSON Schema with the words a refusal uses. They are
 *   published under the root's allOf, so the schema says what the check
 *   does, and checked one by one after the rest, each refused in its own
 *   words.
 * - What JSON Schema cannot say (a date Date.parse reads, a keyword other
 *   than the four IMAP flags) is a zod refinement in `input`, checked last.
 * - `aliases`: old argument names, accepted for one release with a note
 *   ("hasAttachment was renamed to has_attachment; use has_attachment.").
 *   `retired`: names whose release is over, refused with the name to use,
 *   so a wrapper still calling with one is told what to change.
 *   `synonyms`: other names an argument is always taken by, without a note
 *   (find's query for text): the name an assistant reaches for.
 * - `output`: the JSON every successful answer has, when it is one shape.
 */

type Json = Record<string, unknown>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = z.ZodObject<any>

/** A rule across a tool's arguments, as JSON Schema, with its words. */
export type ArgumentRule = {
  /** What a refusal says when the arguments break it. */
  says: string
  /** JSON Schema the arguments must fit; published under the root's allOf. */
  schema: Json
}

export type InnerToolSpec<I extends AnyObject = AnyObject> = {
  name: string
  title: string
  description: string
  input: I
  output?: z.ZodType
  annotations: ToolAnnotations
  /** Old name (or path, "recurrence.monthDays") → new name, for a release. */
  aliases?: Record<string, string>
  /** Old names no longer taken, with the name that replaced each. */
  retired?: Record<string, string>
  /** Other names always taken for an argument, with no note. */
  synonyms?: Record<string, string>
  rules?: ArgumentRule[]
}

/** An old argument name a call used, and the name it is now. */
export type Rename = {
  /** As the call had it: "hasAttachment", "recurrence.monthDays". */
  from: string
  to: string
  /** Its release is over: refused, not renamed. */
  retired: boolean
}

export type ArgumentCheck<T = Record<string, unknown>> =
  | { fits: true; args: T; notes: string[]; renames: Rename[] }
  | {
      fits: false
      problems: string[]
      notes: string[]
      renames: Rename[]
    }

export type CheckOptions = Pick<ValidateOptions, "secretAt" | "handles">

/** A tool as the catalogue keeps it. */
export type ListedTool = {
  name: string
  title: string
  description: string
  inputSchema: Json
  outputSchema?: Json
  annotations: ToolAnnotations
}

export type InnerTool<I extends AnyObject = AnyObject> = InnerToolSpec<I> & {
  /** The input schema as published, its rules under allOf. */
  inputSchema(): Json
  outputSchema(): Json | undefined
  /** The tool for the catalogue; `description` replaces the spec's. */
  listed(description?: string): ListedTool
  /**
   * A call's arguments, checked: old names renamed, the schema, the rules,
   * then zod's refinements. The arguments as the tool reads them, or every
   * problem in PCP's words.
   */
  check(args: unknown, options?: CheckOptions): ArgumentCheck<z.output<I>>
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The old names of `map` a call used. */
function renamesIn(
  args: Json,
  map: Record<string, string> | undefined,
  retired: boolean,
): Rename[] {
  return Object.entries(map ?? {}).flatMap(([from, to]) => {
    const found = applyAliases(args, { [from]: to })

    return found.notes.length > 0 || found.conflict
      ? [{ from, to, retired }]
      : []
  })
}

/** The note in front of an answer for an old name used. */
export function renameNote({ from, to }: Rename): string {
  return `${from} was renamed to ${to}; use ${to}.`
}

export function defineInnerTool<I extends AnyObject>(
  spec: InnerToolSpec<I>,
): InnerTool<I> {
  checkToolName(spec.name)

  const schemas = toolSchemas(spec.name, spec.input, spec.output)
  const rules = spec.rules ?? []
  let published: Json | undefined

  const inputSchema = (): Json => {
    if (!published) {
      const base = schemas.inputSchema()

      published =
        rules.length === 0
          ? base
          : {
              ...base,
              allOf: [
                ...(Array.isArray(base.allOf) ? base.allOf : []),
                ...rules.map((rule) => rule.schema),
              ],
            }
    }

    return published
  }

  return {
    ...spec,
    inputSchema,
    outputSchema: schemas.outputSchema,
    listed(description) {
      const output = schemas.outputSchema()

      return {
        name: spec.name,
        title: spec.title,
        description: description ?? spec.description,
        inputSchema: inputSchema(),
        ...(output ? { outputSchema: output } : {}),
        annotations: spec.annotations,
      }
    },
    check(args, options = {}) {
      const sent = isRecord(args) ? args : {}
      const renames = [
        ...renamesIn(sent, spec.retired, true),
        ...renamesIn(sent, spec.aliases, false),
      ]
      const notes = renames.filter((rename) => !rename.retired).map(renameNote)
      const taken = applyAliases(sent, spec.synonyms)
      const renamed = applyAliases(taken.args, {
        ...spec.retired,
        ...spec.aliases,
      })
      const synonymClash = Object.entries(spec.synonyms ?? {}).find(
        ([from, to]) => Object.hasOwn(sent, from) && Object.hasOwn(sent, to),
      )
      const problems = [
        ...(synonymClash
          ? [
              `${synonymClash[0]} is another name for ${synonymClash[1]}; give one of them.`,
            ]
          : []),
        ...renames
          .filter((rename) => rename.retired)
          .map(
            ({ from, to }) =>
              `${from} was renamed to ${to}, and the old name is no longer taken: use ${to}.`,
          ),
        ...(renamed.conflict ? [renamed.conflict] : []),
      ]

      // What to call an argument comes first: the rest is checked once the
      // names are settled.
      if (problems.length === 0) {
        problems.push(...validate(schemas.inputSchema(), renamed.args, options))
      }

      if (problems.length === 0) {
        for (const rule of rules) {
          if (
            validate(rule.schema, renamed.args, { ...options, maxProblems: 1 })
              .length > 0
          ) {
            problems.push(rule.says)
          }
        }
      }

      if (problems.length > 0) {
        return { fits: false, problems, notes, renames }
      }

      const parsed = spec.input.safeParse(renamed.args)

      return parsed.success
        ? { fits: true, args: parsed.data, notes, renames }
        : {
            fits: false,
            problems: zodProblems(parsed.error.issues),
            notes,
            renames,
          }
    },
  }
}

// Rules that come up in more than one family.

/** Exactly one of these arguments. */
export function exactlyOne(names: string[], says: string): ArgumentRule {
  return {
    says,
    schema: { oneOf: names.map((name) => ({ required: [name] })) },
  }
}

/** At least one of these arguments. */
export function atLeastOne(names: string[], says: string): ArgumentRule {
  return {
    says,
    schema: { anyOf: names.map((name) => ({ required: [name] })) },
  }
}

/** Not all of these arguments together. */
export function notTogether(names: string[], says: string): ArgumentRule {
  return { says, schema: { not: { required: names } } }
}

// Answers a family writes itself, through the one mapping (outcome.ts).

/** An answer in words. */
export function textAnswer(text: string): CallToolResult {
  return toCallToolResult(ok(text))
}

/** A refusal with its code: nothing was done. */
export function familyError(
  message: string,
  code: ToolErrorCode,
  { hint, notes = [] }: { hint?: string; notes?: string[] } = {},
): CallToolResult {
  return toCallToolResult(toolError(message, { code, hint }), { notes })
}

/** Arguments that do not fit: every problem, and that nothing was done. */
export function argumentsResult(
  label: string,
  problems: string[],
  { hint, notes = [] }: { hint?: string; notes?: string[] } = {},
): CallToolResult {
  return familyError(
    argumentsRefusal(label, problems, { lead: "nothing was done", hint }),
    "invalid_arguments",
    { notes },
  )
}

/** An answer with notes in front of it, each a text of its own. */
export function withNotes(
  result: CallToolResult,
  notes: string[],
): CallToolResult {
  return notes.length === 0
    ? result
    : {
        ...result,
        content: [
          ...notes.map((note) => ({ type: "text" as const, text: note })),
          ...result.content,
        ],
      }
}

/**
 * A PcpError a family's run threw, as its answer: arguments it found wrong
 * once it could look (a range the wrong way round) and other refusals are
 * tool errors with their code. Null for a failure on the way to the server
 * ("upstream") or a sign-in it needs ("unauthorized"), which the caller
 * throws on: the gateway connects the one and says the other may have gone
 * through.
 */
export function refusalOf(
  error: unknown,
  label: string,
  notes: string[] = [],
): CallToolResult | null {
  if (
    !isPcpError(error) ||
    error.code === "upstream" ||
    error.code === "unauthorized"
  ) {
    return null
  }

  return error.code === "validation"
    ? argumentsResult(label, [error.message], { notes })
    : familyError(error.message, error.code, { notes })
}
