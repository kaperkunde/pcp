import YAML from "yaml"

import { MAX_SPEC_BYTES } from "../constants"
import { invalid, isPcpError } from "../errors"
import { isObject, type JsonObject } from "./json"
import { MAX_SPEC_NODES, MAX_YAML_ALIASES } from "./limits"

/**
 * Turns schema text into a plain JSON value and checks it is OpenAPI 3.
 * YAML is read with the core schema and no custom tags, so nothing in the
 * document can construct anything but strings, numbers, booleans, null,
 * arrays and objects; aliases are capped so a "billion laughs" document
 * fails instead of expanding.
 */

export type OpenApiDocument = JsonObject & {
  openapi: string
  paths: JsonObject
}

/**
 * Counts the nodes of a parsed value with every alias visited as often as it
 * appears, stopping at the limit. A cycle never ends, so it stops there too.
 */
function withinNodeLimit(value: unknown, limit: number): boolean {
  return countNodes(value, limit) <= limit
}

/**
 * How many nodes a value has, counted the same way; past the limit it stops
 * and answers limit + 1.
 */
export function countNodes(value: unknown, limit: number): number {
  const stack: unknown[] = [value]
  let seen = 0

  while (stack.length > 0) {
    const current = stack.pop()
    seen += 1

    if (seen > limit) {
      return seen
    }

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
    } else if (typeof current === "object" && current !== null) {
      for (const item of Object.values(current)) stack.push(item)
    }
  }

  return seen
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").trim().slice(0, 300)
}

export function parseSpecText(raw: string): OpenApiDocument {
  if (Buffer.byteLength(raw, "utf8") > MAX_SPEC_BYTES) {
    throw invalid(
      `That schema is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB.`,
    )
  }

  const text = raw.replace(/^﻿/, "").trim()

  if (!text) {
    throw invalid("The schema is empty.")
  }

  let value: unknown

  try {
    if (text.startsWith("{")) {
      value = JSON.parse(text)
    } else {
      value = YAML.parse(text, {
        version: "1.2",
        schema: "core",
        customTags: [],
        resolveKnownTags: false,
        merge: false,
        // Checking keys for duplicates is quadratic in how many there are:
        // 40,000 paths took 18 seconds. JSON takes the last of a duplicate
        // too.
        uniqueKeys: false,
        stringKeys: true,
        maxAliasCount: MAX_YAML_ALIASES,
        // "silent" would swallow parse errors; "error" throws them and
        // drops warnings (unknown tags come back as plain strings).
        logLevel: "error",
      })
      if (!withinNodeLimit(value, MAX_SPEC_NODES)) {
        throw invalid(
          "The schema is too large once its anchors and aliases are expanded.",
        )
      }

      // Only plain JSON values from here on.
      value = JSON.parse(JSON.stringify(value ?? null))
    }
  } catch (error) {
    if (isPcpError(error)) {
      throw error
    }

    throw invalid(
      `The schema could not be read as JSON or YAML: ${short(error)}`,
    )
  }

  return checkDocument(value)
}

/**
 * What a document must be to be read as OpenAPI 3: checked on what the text
 * parsed to, and again once the endpoint's edits are applied to it.
 */
export function checkDocument(value: unknown): OpenApiDocument {
  if (!isObject(value)) {
    throw invalid("That is not an OpenAPI document.")
  }

  if (typeof value.swagger === "string") {
    throw invalid(
      "This is a Swagger 2.0 document. Convert it to OpenAPI 3 first (the Swagger Editor can).",
    )
  }

  if (typeof value.openapi !== "string" || !/^3\.\d+/.test(value.openapi)) {
    throw invalid(
      "That does not look like an OpenAPI 3 document: it has no openapi: 3.x field.",
    )
  }

  if (value.paths !== undefined && !isObject(value.paths)) {
    throw invalid("The schema's paths are not an object.")
  }

  return {
    ...value,
    openapi: value.openapi,
    paths: isObject(value.paths) ? value.paths : {},
  }
}
