import { isIPv4, isIPv6 } from "node:net"

import {
  MAX_ARGUMENT_PROBLEMS,
  MAX_LISTED_KEYS,
  MAX_PATTERN_CHARS,
  MAX_PATTERN_SUBJECT_CHARS,
  MAX_REF_HOPS,
  MAX_VALIDATE_DEPTH,
  MAX_VALIDATE_STEPS,
} from "./limits"

/**
 * The one check of a value against a JSON Schema, for every way a call
 * reaches a tool: the arguments of PCP's own tools (define.ts), and those of
 * a call_tool or a run_code program's pcp.call against the inputSchema the
 * server or the API declared, before anything runs or the owner is asked.
 *
 * Strict, as the schema says (JSON Schema 2020-12, with the draft-07 forms
 * servers still send): types, enum and const, required, properties,
 * additionalProperties, patternProperties, propertyNames, min/max
 * properties, dependentRequired and dependentSchemas, items, prefixItems,
 * contains, min/max items, uniqueItems, min/max length, pattern, minimum,
 * maximum and their exclusive forms, multipleOf, allOf, anyOf, a true oneOf
 * (exactly one), not, if/then/else, unevaluatedProperties (against the
 * properties the schema and its subschemas name) and the formats date,
 * date-time, email, uri, uuid, ipv4 and ipv6. Other formats and keywords
 * are notes, as the specification has them. OpenAPI 3.0's `nullable` is
 * honoured.
 *
 * Written out rather than a validator library's: a schema comes from a
 * server PCP does not control, and a library that compiles schemas to code
 * would run it. References are followed only inside the schema
 * (`#/$defs/…`, `#/definitions/…`), a bounded number in a row; one to
 * another document is refused, since PCP never fetches one. A pattern that
 * could take exponential time (a repeated group that repeats inside, a
 * backreference) or is very long is not run, nor is any pattern on a very
 * long string: the tool decides those. Every walk is bounded (limits.ts).
 *
 * A kept result's handle ({"$result": id}, result-handles.ts) stands for a
 * string PCP fills in later, so it passes wherever a string may go, its
 * length and pattern unknown until then. {"$secret": name} passes only
 * where `secretAt` says the rules let one in (a wrapper's binding, the
 * browser's type text), and only where a string may go.
 */

export type ValidateOptions = {
  /** What the schema is called in messages: "inputSchema" by default. */
  schemaName?: string
  /** What the value as a whole is called: "The arguments" by default. */
  whole?: string
  /**
   * The value is a call's arguments, so a key at the top that the schema
   * does not take is "not an argument of this tool". True by default.
   */
  arguments?: boolean
  /** A kept result's handle stands for a string. True by default. */
  handles?: boolean
  /** Where, by JSON Pointer, {"$secret": name} may stand for a string. */
  secretAt?: (pointer: string) => boolean
  /** At most this many problems; MAX_ARGUMENT_PROBLEMS by default. */
  maxProblems?: number
}

/**
 * Something a family of tools can add to a refusal of arguments that do not
 * fit, from the arguments as they were sent: the browser names the token's
 * open tabs when `tab` is wrong, say. Undefined adds nothing.
 */
export type InvalidHint = (args: Record<string, unknown>) => string | undefined

type Json = Record<string, unknown>

class TooLarge extends Error {}

type Walk = {
  root: unknown
  steps: number
  schemaName: string
  whole: string
  arguments: boolean
  handles: boolean
  secretAt: ((pointer: string) => boolean) | undefined
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A kept result's handle, as result-handles.ts parseHandle reads one. */
export function isResultHandle(value: unknown): boolean {
  if (!isRecord(value) || typeof value.$result !== "string") {
    return false
  }

  const keys = Object.keys(value)

  return (
    value.$result.length > 0 &&
    value.$result.length <= 64 &&
    keys.every((key) => key === "$result" || key === "as") &&
    (value.as === undefined || value.as === "text" || value.as === "base64")
  )
}

/** {"$secret": name}, a secret's placeholder (wrappers/placeholders.ts). */
function isSecretPlaceholder(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.$secret === "string" &&
    Object.keys(value).length === 1
  )
}

function kindOf(value: unknown): string {
  if (value === null) {
    return "null"
  }

  if (Array.isArray(value)) {
    return "array"
  }

  if (isResultHandle(value)) {
    return "a kept result's handle (which stands for a string)"
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return "integer"
  }

  return typeof value
}

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: isRecord,
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1")
}

function where(at: string, walk: Walk): string {
  return at === "" ? walk.whole : `"${at.slice(1)}"`
}

function step(walk: Walk): void {
  if (--walk.steps < 0) {
    throw new TooLarge()
  }
}

/** JSON values compared as JSON: object keys in any order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    )
  }

  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)

    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    )
  }

  return false
}

/** A value's JSON with its object keys sorted: equal values, equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  }

  return JSON.stringify(value) ?? "null"
}

function quoteList(values: unknown[]): string {
  const shown = values.slice(0, 20).map((value) => JSON.stringify(value))

  return values.length > shown.length
    ? `${shown.join(", ")} and ${values.length - shown.length} more`
    : shown.join(", ")
}

// ---- Patterns ----------------------------------------------------------------

const patterns = new Map<string, RegExp | null>()

/**
 * Whether a pattern could take more than polynomial time, or high-degree
 * polynomial time, on a string made for it: a backreference, a repeated
 * group with a repetition or an alternation inside ((a+)+, (a|aa)*), or
 * more than three unbounded repetitions in all.
 */
export function riskyPattern(pattern: string): boolean {
  if (/\\[1-9]|\\k</.test(pattern)) {
    return true
  }

  const groups: Array<{ repeats: boolean; alternates: boolean }> = []
  let inClass = false
  let unbounded = 0

  const repetitionAt = (index: number): boolean => {
    const next = pattern[index]

    if (next === "*" || next === "+") {
      return true
    }

    if (next === "{") {
      const brace = /^\{(\d*),(\d*)\}/.exec(pattern.slice(index))
      return brace !== null && (brace[2] === "" || Number(brace[2]) > 1)
    }

    return false
  }

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]

    if (char === "\\") {
      // An escaped character, then whatever repeats it.
      if (repetitionAt(index + 2)) {
        unbounded++
        if (groups.length > 0) groups[groups.length - 1]!.repeats = true
      }
      index++
      continue
    }

    if (inClass) {
      if (char === "]") {
        inClass = false
        if (repetitionAt(index + 1)) {
          unbounded++
          if (groups.length > 0) groups[groups.length - 1]!.repeats = true
        }
      }
      continue
    }

    if (char === "[") {
      inClass = true
      continue
    }

    if (char === "(") {
      groups.push({ repeats: false, alternates: false })
      continue
    }

    if (char === "|") {
      if (groups.length > 0) groups[groups.length - 1]!.alternates = true
      continue
    }

    if (char === ")") {
      const group = groups.pop()
      const repeated = repetitionAt(index + 1)

      if (group && repeated && (group.repeats || group.alternates)) {
        return true
      }

      if (repeated) {
        unbounded++
      }

      if (groups.length > 0 && (repeated || group?.repeats)) {
        groups[groups.length - 1]!.repeats = true
      }
      continue
    }

    if (repetitionAt(index + 1) && char !== "*" && char !== "+") {
      unbounded++
      if (groups.length > 0) groups[groups.length - 1]!.repeats = true
    }
  }

  return unbounded > 3
}

/** The pattern compiled, or null when PCP leaves it to the tool. */
function compiled(pattern: string): RegExp | null {
  if (patterns.has(pattern)) {
    return patterns.get(pattern)!
  }

  let regex: RegExp | null = null

  if (pattern.length <= MAX_PATTERN_CHARS && !riskyPattern(pattern)) {
    try {
      regex = new RegExp(pattern, "u")
    } catch {
      try {
        regex = new RegExp(pattern)
      } catch {
        regex = null
      }
    }
  }

  if (patterns.size > 1_000) {
    patterns.clear()
  }

  patterns.set(pattern, regex)
  return regex
}

/** Whether a string matches a pattern; true when PCP does not run it. */
function matches(pattern: string, value: string): boolean {
  if (value.length > MAX_PATTERN_SUBJECT_CHARS) {
    return true
  }

  const regex = compiled(pattern)

  return regex === null || regex.test(value)
}

// ---- Formats -----------------------------------------------------------------

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    month >= 1 &&
    month <= 12 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/
const EMAIL = /^[^\s@]+@[^\s@]+$/
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const FORMATS: Record<
  string,
  { test: (value: string) => boolean; example: string }
> = {
  date: {
    test: (value) => {
      const match = DATE.exec(value)
      return (
        match !== null &&
        validDate(Number(match[1]), Number(match[2]), Number(match[3]))
      )
    },
    example: "2026-10-29",
  },
  "date-time": {
    test: (value) => {
      const match = DATE_TIME.exec(value)
      return (
        match !== null &&
        validDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
        Number(match[4]) <= 23 &&
        Number(match[5]) <= 59 &&
        Number(match[6]) <= 60 &&
        (match[9] === undefined ||
          (Number(match[9]) <= 23 && Number(match[10]) <= 59))
      )
    },
    example: "2026-10-29T14:30:00Z",
  },
  email: { test: (value) => EMAIL.test(value), example: "ada@example.com" },
  uri: {
    test: (value) => {
      if (!URI_SCHEME.test(value) || /\s/.test(value)) {
        return false
      }

      try {
        new URL(value)
        return true
      } catch {
        return false
      }
    },
    example: "https://example.com/page",
  },
  uuid: {
    test: (value) => UUID.test(value),
    example: "123e4567-e89b-12d3-a456-426614174000",
  },
  ipv4: { test: (value) => isIPv4(value), example: "192.0.2.1" },
  ipv6: { test: (value) => isIPv6(value), example: "2001:db8::1" },
}

// ---- References ----------------------------------------------------------------

type Resolved = { schema: unknown } | { problem: string } | { skip: true }

function resolveRef(ref: string, walk: Walk): Resolved {
  if (!ref.startsWith("#")) {
    return {
      problem: `The ${walk.schemaName} refers to ${JSON.stringify(ref.slice(0, 200))}, outside itself; PCP never fetches another document, so it cannot check these arguments. The tool's schema needs its definitions inside it (#/$defs/…).`,
    }
  }

  const fragment = ref.slice(1)

  // A named anchor (#name) is more than this check looks for.
  if (fragment !== "" && !fragment.startsWith("/")) {
    return { skip: true }
  }

  let node: unknown = walk.root

  for (const raw of fragment === "" ? [] : fragment.slice(1).split("/")) {
    let segment: string

    try {
      segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~")
    } catch {
      segment = raw
    }

    if (Array.isArray(node) && /^\d+$/.test(segment)) {
      node = node[Number(segment)]
    } else if (isRecord(node) && Object.hasOwn(node, segment)) {
      node = node[segment]
    } else {
      return {
        problem: `The ${walk.schemaName} refers to ${JSON.stringify(ref.slice(0, 200))}, which it does not define.`,
      }
    }
  }

  return { schema: node }
}

/** Whether a string may stand where this schema is, as far as it says. */
function admitsString(schema: unknown, walk: Walk, hops = 0): boolean {
  step(walk)

  if (schema === false) {
    return false
  }

  if (!isRecord(schema) || hops > MAX_REF_HOPS) {
    return true
  }

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, walk)

    if (
      "schema" in resolved &&
      !admitsString(resolved.schema, walk, hops + 1)
    ) {
      return false
    }
  }

  const type = schema.type

  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]

    if (!types.includes("string")) {
      return false
    }
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => typeof v === "string")
  ) {
    return false
  }

  if ("const" in schema && typeof schema.const !== "string") {
    return false
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key]

    if (
      Array.isArray(options) &&
      options.length > 0 &&
      !options.some((option) => admitsString(option, walk, hops + 1))
    ) {
      return false
    }
  }

  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((option) => admitsString(option, walk, hops + 1))
  ) {
    return false
  }

  return true
}

// ---- The walk -------------------------------------------------------------------

/** The property names a schema and the subschemas it applies in place name. */
function evaluatedNames(schema: Json, walk: Walk, hops = 0): Set<string> {
  step(walk)

  const names = new Set<string>(
    isRecord(schema.properties) ? Object.keys(schema.properties) : [],
  )

  if (hops > MAX_REF_HOPS) {
    return names
  }

  const nested: unknown[] = [
    ...(["allOf", "anyOf", "oneOf"] as const).flatMap((key) =>
      Array.isArray(schema[key]) ? (schema[key] as unknown[]) : [],
    ),
    schema.then,
    schema.else,
  ]

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, walk)

    if ("schema" in resolved) {
      nested.push(resolved.schema)
    }
  }

  for (const sub of nested) {
    if (isRecord(sub)) {
      for (const name of evaluatedNames(sub, walk, hops + 1)) {
        names.add(name)
      }
    }
  }

  return names
}

function check(
  schema: unknown,
  value: unknown,
  at: string,
  depth: number,
  hops: number,
  walk: Walk,
  limit: number,
): string[] {
  step(walk)

  if (schema === true || schema === undefined) {
    return []
  }

  if (schema === false) {
    return [`${where(at, walk)} is not allowed by the ${walk.schemaName}.`]
  }

  if (!isRecord(schema)) {
    return []
  }

  if (depth > MAX_VALIDATE_DEPTH) {
    return [
      `${where(at, walk)} nests more than ${MAX_VALIDATE_DEPTH} levels deep, more than PCP checks.`,
    ]
  }

  // OpenAPI 3.0: null where the schema says nullable.
  if (value === null && schema.nullable === true) {
    return []
  }

  // A handle, or a secret where one may go, is a string PCP fills in later.
  if (
    (walk.handles && isResultHandle(value)) ||
    (walk.secretAt && isSecretPlaceholder(value) && walk.secretAt(at))
  ) {
    if (admitsString(schema, walk)) {
      return []
    }
  }

  const problems: string[] = []
  const add = (...found: string[]) => {
    for (const problem of found) {
      if (problems.length < limit) {
        problems.push(problem)
      }
    }
  }
  const full = () => problems.length >= limit
  const label = where(at, walk)
  const named = walk.schemaName

  if (typeof schema.$ref === "string") {
    if (hops >= MAX_REF_HOPS) {
      return [
        `The ${named} refers to itself more than ${MAX_REF_HOPS} times in a row at ${label}, more than PCP follows.`,
      ]
    }

    const resolved = resolveRef(schema.$ref, walk)

    if ("problem" in resolved) {
      return [resolved.problem]
    }

    if ("schema" in resolved) {
      add(...check(resolved.schema, value, at, depth, hops + 1, walk, limit))
    }

    if (full()) {
      return problems
    }
  }

  const type = schema.type
  const types = (Array.isArray(type) ? type : [type]).filter(
    (entry): entry is string => typeof entry === "string",
  )

  if (
    types.length > 0 &&
    !types.some((entry) => TYPES[entry]?.(value) ?? true) &&
    !(value === null && schema.nullable === true)
  ) {
    return [
      ...problems,
      `${label} is ${kindOf(value)}, but the ${named} says ${types.join(" or ")}.`,
    ].slice(0, limit)
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((o) => sameJson(o, value))
  ) {
    add(
      `${label} is not one of the ${named}'s enum values (${quoteList(schema.enum)}).`,
    )
  }

  if ("const" in schema && !sameJson(schema.const, value)) {
    add(
      `${label} is not ${JSON.stringify(schema.const)}, which the ${named} requires.`,
    )
  }

  if (typeof value === "string") {
    const length = [...value].length

    if (typeof schema.minLength === "number" && length < schema.minLength) {
      add(
        `${label} is ${length} character${length === 1 ? "" : "s"} long, but the ${named} says at least ${schema.minLength}.`,
      )
    }

    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      add(
        `${label} is ${length} characters long, but the ${named} says at most ${schema.maxLength}.`,
      )
    }

    if (typeof schema.pattern === "string" && !matches(schema.pattern, value)) {
      // What the value is meant to be, in the schema's own words, says
      // more than a pattern does.
      const meant =
        typeof schema.description === "string" &&
        schema.description.length <= 200
          ? ` (${schema.description.trim().replace(/\.$/, "")})`
          : ""

      add(
        `${label} does not match the ${named}'s pattern ${schema.pattern}${meant}.`,
      )
    }

    const format =
      typeof schema.format === "string" ? FORMATS[schema.format] : undefined

    if (format && !format.test(value)) {
      add(
        `${label} is not a valid ${String(schema.format)}, such as ${format.example}.`,
      )
    }
  }

  if (typeof value === "number") {
    checkNumber(schema, value, label, named, add)
  }

  if (Array.isArray(value)) {
    checkArray(schema, value, at, depth, walk, limit, add, full)
  }

  if (isRecord(value)) {
    checkObject(schema, value, at, depth, walk, limit, add, full)
  }

  if (!full()) {
    checkComposition(schema, value, at, depth, hops, walk, limit, add)
  }

  return problems
}

function checkNumber(
  schema: Json,
  value: number,
  label: string,
  named: string,
  add: (...found: string[]) => void,
): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } =
    schema

  if (typeof minimum === "number") {
    if (exclusiveMinimum === true ? value <= minimum : value < minimum) {
      add(
        `${label} is ${value}, but the ${named} says ${exclusiveMinimum === true ? "more than" : "at least"} ${minimum}.`,
      )
    }
  }

  if (typeof maximum === "number") {
    if (exclusiveMaximum === true ? value >= maximum : value > maximum) {
      add(
        `${label} is ${value}, but the ${named} says ${exclusiveMaximum === true ? "less than" : "at most"} ${maximum}.`,
      )
    }
  }

  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
    add(
      `${label} is ${value}, but the ${named} says more than ${exclusiveMinimum}.`,
    )
  }

  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
    add(
      `${label} is ${value}, but the ${named} says less than ${exclusiveMaximum}.`,
    )
  }

  if (typeof multipleOf === "number" && multipleOf > 0) {
    const ratio = value / multipleOf

    if (
      Math.abs(ratio - Math.round(ratio)) >
      1e-9 * Math.max(1, Math.abs(ratio))
    ) {
      add(
        `${label} is ${value}, but the ${named} says a multiple of ${multipleOf}.`,
      )
    }
  }
}

function checkArray(
  schema: Json,
  value: unknown[],
  at: string,
  depth: number,
  walk: Walk,
  limit: number,
  add: (...found: string[]) => void,
  full: () => boolean,
): void {
  const label = where(at, walk)
  const named = walk.schemaName
  const { minItems, maxItems } = schema

  if (typeof minItems === "number" && value.length < minItems) {
    add(
      `${label} has ${value.length} item${value.length === 1 ? "" : "s"}, but the ${named} says at least ${minItems}.`,
    )
  }

  if (typeof maxItems === "number" && value.length > maxItems) {
    add(
      `${label} has ${value.length} items, but the ${named} says at most ${maxItems}.`,
    )
  }

  if (schema.uniqueItems === true) {
    const seen = new Set<string>()

    for (const item of value) {
      step(walk)
      const key = canonical(item)

      if (seen.has(key)) {
        add(
          `${label} has the same item twice, but the ${named} says its items are unique.`,
        )
        break
      }

      seen.add(key)
    }
  }

  // Draft-07's tuple (items as a list, additionalItems after it), or
  // 2020-12's prefixItems and items after them.
  const prefix = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : []
  const rest = Array.isArray(schema.items)
    ? schema.additionalItems
    : schema.items

  for (const [index, item] of value.entries()) {
    if (full()) {
      return
    }

    const itemSchema = index < prefix.length ? prefix[index] : rest

    if (itemSchema === undefined) {
      continue
    }

    if (itemSchema === false && index >= prefix.length) {
      add(
        `${label} has ${value.length} items, but the ${named} says at most ${prefix.length}.`,
      )
      return
    }

    add(...check(itemSchema, item, `${at}/${index}`, depth + 1, 0, walk, limit))
  }

  if (schema.contains !== undefined) {
    const count = value.filter(
      (item, index) =>
        check(schema.contains, item, `${at}/${index}`, depth + 1, 0, walk, 1)
          .length === 0,
    ).length
    const least =
      typeof schema.minContains === "number" ? schema.minContains : 1

    if (count < least) {
      add(
        `${label} has ${count} item${count === 1 ? "" : "s"} like the ${named}'s contains, and it says at least ${least}.`,
      )
    }

    if (typeof schema.maxContains === "number" && count > schema.maxContains) {
      add(
        `${label} has ${count} items like the ${named}'s contains, and it says at most ${schema.maxContains}.`,
      )
    }
  }
}

function checkObject(
  schema: Json,
  value: Json,
  at: string,
  depth: number,
  walk: Walk,
  limit: number,
  add: (...found: string[]) => void,
  full: () => boolean,
): void {
  const label = where(at, walk)
  const named = walk.schemaName
  const keys = Object.keys(value)
  const child = (key: string) => `${at}/${escapeSegment(key)}`

  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === "string" && !Object.hasOwn(value, name)) {
        add(`${where(child(name), walk)} is missing; the ${named} requires it.`)
      }
    }
  }

  if (
    typeof schema.minProperties === "number" &&
    keys.length < schema.minProperties
  ) {
    add(
      `${label} has ${keys.length} keys, but the ${named} says at least ${schema.minProperties}.`,
    )
  }

  if (
    typeof schema.maxProperties === "number" &&
    keys.length > schema.maxProperties
  ) {
    add(
      `${label} has ${keys.length} keys, but the ${named} says at most ${schema.maxProperties}.`,
    )
  }

  // Draft-07's dependencies: a list is dependentRequired, a schema
  // dependentSchemas.
  const dependencies = isRecord(schema.dependencies) ? schema.dependencies : {}
  const required = {
    ...Object.fromEntries(
      Object.entries(dependencies).filter(([, need]) => Array.isArray(need)),
    ),
    ...(isRecord(schema.dependentRequired) ? schema.dependentRequired : {}),
  }
  const dependent = {
    ...Object.fromEntries(
      Object.entries(dependencies).filter(([, need]) => !Array.isArray(need)),
    ),
    ...(isRecord(schema.dependentSchemas) ? schema.dependentSchemas : {}),
  }

  for (const [name, need] of Object.entries(required)) {
    if (Object.hasOwn(value, name) && Array.isArray(need)) {
      for (const other of need) {
        if (typeof other === "string" && !Object.hasOwn(value, other)) {
          add(
            `${where(child(other), walk)} is missing; the ${named} requires it with "${name}".`,
          )
        }
      }
    }
  }

  for (const [name, sub] of Object.entries(dependent)) {
    if (Object.hasOwn(value, name) && !full()) {
      add(...check(sub, value, at, depth, 1, walk, limit))
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {}
  const patternProperties = isRecord(schema.patternProperties)
    ? schema.patternProperties
    : {}
  const evaluated =
    schema.unevaluatedProperties !== undefined
      ? evaluatedNames(schema, walk)
      : null

  for (const [name, item] of Object.entries(value)) {
    if (full()) {
      return
    }

    step(walk)

    if (
      schema.propertyNames !== undefined &&
      check(schema.propertyNames, name, child(name), depth + 1, 0, walk, 1)
        .length > 0
    ) {
      add(`${where(child(name), walk)} is not a key name the ${named} allows.`)
      continue
    }

    let known = false

    if (Object.hasOwn(properties, name)) {
      known = true
      add(
        ...check(
          properties[name],
          item,
          child(name),
          depth + 1,
          0,
          walk,
          limit,
        ),
      )
    }

    for (const [pattern, sub] of Object.entries(patternProperties)) {
      const regex = compiled(pattern)

      // A pattern PCP does not run counts as matching: the tool decides.
      if (regex === null) {
        known = true
      } else if (regex.test(name)) {
        known = true
        add(...check(sub, item, child(name), depth + 1, 0, walk, limit))
      }
    }

    if (known) {
      continue
    }

    const extra =
      schema.additionalProperties !== undefined
        ? schema.additionalProperties
        : evaluated && !evaluated.has(name)
          ? schema.unevaluatedProperties
          : undefined

    if (extra === false) {
      const takes = Object.keys(properties)
      const listed =
        takes.length > MAX_LISTED_KEYS
          ? `${takes.slice(0, MAX_LISTED_KEYS).join(", ")} and ${takes.length - MAX_LISTED_KEYS} more`
          : takes.join(", ") || "none"

      add(
        at === "" && walk.arguments
          ? `"${name}" is not an argument of this tool (it takes: ${listed}).`
          : `${where(child(name), walk)} is not a key the ${named} allows${at === "" ? "" : ` in ${label}`} (it takes: ${listed}).`,
      )
    } else if (extra !== undefined) {
      add(...check(extra, item, child(name), depth + 1, 0, walk, limit))
    }
  }
}

function checkComposition(
  schema: Json,
  value: unknown,
  at: string,
  depth: number,
  hops: number,
  walk: Walk,
  limit: number,
  add: (...found: string[]) => void,
): void {
  const label = where(at, walk)
  const named = walk.schemaName
  const branch = (sub: unknown, max = 3) =>
    check(sub, value, at, depth, hops + 1, walk, max)

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      add(...branch(sub, limit))
    }
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key]

    if (!Array.isArray(options) || options.length === 0) {
      continue
    }

    const results = options.map((option) => branch(option))
    const fitting = results.filter((found) => found.length === 0).length

    if (fitting === 0) {
      // The option it comes closest to, for what to change.
      const closest = results.reduce((best, found) =>
        found.length < best.length ? found : best,
      )

      add(
        `${label} matches none of the ${named}'s ${key} options; the closest says: ${closest[0]!.replace(/\.$/, "")}.`,
      )
    } else if (key === "oneOf" && fitting > 1) {
      add(
        `${label} matches ${fitting} of the ${named}'s oneOf options, and it should match exactly one.`,
      )
    }
  }

  if (schema.not !== undefined && branch(schema.not, 1).length === 0) {
    add(`${label} is what the ${named} rules out (its "not").`)
  }

  if (schema.if !== undefined) {
    const then = branch(schema.if, 1).length === 0 ? schema.then : schema.else

    if (then !== undefined) {
      add(...branch(then, limit))
    }
  }
}

/**
 * What is wrong with a value against its schema, one line per problem in
 * PCP's words: empty when it fits.
 */
export function validate(
  schema: unknown,
  value: unknown,
  options: ValidateOptions = {},
): string[] {
  const walk: Walk = {
    root: schema,
    steps: MAX_VALIDATE_STEPS,
    schemaName: options.schemaName ?? "inputSchema",
    whole: options.whole ?? "The arguments",
    arguments: options.arguments ?? true,
    handles: options.handles ?? true,
    secretAt: options.secretAt,
  }
  const limit = options.maxProblems ?? MAX_ARGUMENT_PROBLEMS

  try {
    return check(schema, value, "", 0, 0, walk, limit)
  } catch (error) {
    if (error instanceof TooLarge) {
      return [
        `${walk.whole} are too large for PCP to check against the ${walk.schemaName}: send fewer or smaller values.`,
      ]
    }

    throw error
  }
}

/**
 * The refusal of arguments that do not fit, for an assistant: what is wrong,
 * that nothing ran, and what the tool family adds.
 */
export function argumentsRefusal(
  tool: string,
  problems: string[],
  {
    lead = "nothing was run or asked",
    hint,
  }: { lead?: string; hint?: string } = {},
): string {
  return [
    `These arguments do not fit ${tool}'s inputSchema, so ${lead}:`,
    ...problems.map((problem) => `- ${problem}`),
    ...(hint ? ["", hint] : []),
  ].join("\n")
}

/**
 * What a zod check found wrong, in the words validate uses: for the rules
 * JSON Schema cannot say (a refinement), checked after the schema.
 */
export function zodProblems(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string[] {
  return issues.map((issue) =>
    issue.path.length > 0
      ? `"${issue.path.map(String).join("/")}": ${issue.message}`
      : issue.message,
  )
}
