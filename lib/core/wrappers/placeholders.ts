import { invalid } from "../errors"
import { makeRedactor } from "../openapi/redact"
import type { CallToolResult } from "@modelcontextprotocol/server"

import { MAX_PLACEHOLDER_DEPTH, MAX_PLACEHOLDER_NODES } from "./limits"

/**
 * A secret in a wrapper's call: {"$secret": "<name>"} stands for the value
 * of the owner's secret by that name, where the owner allowed that secret to
 * go (a binding: one argument of one tool, lib/core/wrappers/definition.ts).
 * A wrapper's program writes the placeholder and never sees the value; PCP
 * puts the value in at the last moment, in upstream.ts, and only where a
 * binding the owner approved names that very tool and argument.
 *
 * This file reads no secret and touches no database.
 */

export type SecretPlaceholder = { $secret: string }

/** Where a placeholder sits in a call's arguments, and what it names. */
export type FoundPlaceholder = { pointer: string; name: string }

/**
 * What a call may carry: for each argument the owner allowed, the secret
 * that goes there and how it is written. Made by the wrapper's caller from
 * the bindings (run.ts), checked again in upstream.ts before any value is
 * read.
 */
export type SecretGrant = Array<{
  pointer: string
  name: string
  secretId: string
  /** How the value is written, with {{secret}} where it goes. */
  template: string
  /** The server's address as the owner approved it. */
  url: string
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The secret's name a value stands for, or null when it is no placeholder. */
export function parseSecretPlaceholder(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }

  const keys = Object.keys(value)

  if (keys.length !== 1 || keys[0] !== "$secret") {
    return null
  }

  return typeof value.$secret === "string" &&
    value.$secret.length > 0 &&
    value.$secret.length <= 200
    ? value.$secret
    : null
}

function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1")
}

/**
 * Every placeholder in a call's arguments, by JSON Pointer. An object with a
 * "$secret" key that is not a well-formed placeholder is refused rather than
 * passed on, so a mistake never sends the name in place of the value.
 */
export function findPlaceholders(args: unknown): FoundPlaceholder[] {
  const found: FoundPlaceholder[] = []
  let nodes = 0

  const walk = (value: unknown, pointer: string, depth: number) => {
    if (++nodes > MAX_PLACEHOLDER_NODES) {
      throw invalid("A call's arguments have too many values to check.")
    }

    if (depth > MAX_PLACEHOLDER_DEPTH) {
      throw invalid("A call's arguments nest too deeply.")
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        walk(item, `${pointer}/${index}`, depth + 1),
      )
      return
    }

    if (!isRecord(value)) {
      return
    }

    if (Object.hasOwn(value, "$secret")) {
      const name = parseSecretPlaceholder(value)

      if (name === null) {
        throw invalid(
          `A secret goes in a call as {"$secret": "<its name>"} and nothing else (at ${pointer || "/"}).`,
        )
      }

      found.push({ pointer, name })
      return
    }

    for (const [key, item] of Object.entries(value)) {
      walk(item, `${pointer}/${escapeToken(key)}`, depth + 1)
    }
  }

  walk(args, "", 0)
  return found
}

/** The arguments with each placeholder replaced by its written value. */
export function placeValues(
  args: Record<string, unknown>,
  values: Map<string, string>,
): Record<string, unknown> {
  const walk = (value: unknown, pointer: string): unknown => {
    if (values.has(pointer)) {
      return values.get(pointer)
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${pointer}/${index}`))
    }

    if (!isRecord(value)) {
      return value
    }

    const out: Record<string, unknown> = {}

    for (const [key, item] of Object.entries(value)) {
      if (key !== "__proto__") {
        out[key] = walk(item, `${pointer}/${escapeToken(key)}`)
      }
    }

    return out
  }

  return walk(args, "") as Record<string, unknown>
}

/**
 * Which binding each placeholder goes by: every placeholder needs one for
 * its exact place and name, or the call is refused before anything is read
 * or sent.
 */
export function matchGrant(
  found: FoundPlaceholder[],
  grant: SecretGrant | undefined,
  where: string,
): SecretGrant {
  return found.map((placeholder) => {
    const binding = grant?.find(
      (entry) =>
        entry.pointer === placeholder.pointer &&
        entry.name === placeholder.name,
    )

    if (!binding) {
      throw invalid(
        `The owner has not allowed the secret "${placeholder.name}" in ${where} at ${placeholder.pointer || "/"}, so the call was not made.`,
      )
    }

    return binding
  })
}

/**
 * A tool's answer with the given values taken out of its text, its
 * structured content and any text resource, for an answer to a call that
 * carried a secret: an echo of it never reaches the program or the
 * assistant.
 */
export function scrubResult(
  result: CallToolResult,
  values: string[],
): CallToolResult {
  if (values.length === 0) {
    return result
  }

  const scrub = makeRedactor(values)

  return {
    ...result,
    content: result.content.map((part) => {
      if (part.type === "text") {
        return { ...part, text: scrub.text(part.text) }
      }

      if (part.type === "resource" && "text" in part.resource) {
        return {
          ...part,
          resource: { ...part.resource, text: scrub.text(part.resource.text) },
        }
      }

      return part
    }),
    ...(result.structuredContent !== undefined
      ? {
          structuredContent: scrub.value(result.structuredContent) as Record<
            string,
            unknown
          >,
        }
      : {}),
  }
}
