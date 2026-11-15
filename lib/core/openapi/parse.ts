import { invalid, isPcpError } from "../errors"
import { resourceLimits } from "../resources/state"
import { isObject, type JsonObject } from "./json"
import { MAX_SPEC_NODES } from "./limits"
import { countNodes } from "./nodes"
import {
  convertInline,
  convertInWorker,
  YamlTooLarge,
  YamlUnreadable,
} from "./yaml-json"

/**
 * Turns schema text into a plain JSON value and checks it is OpenAPI 3.
 * YAML is read by yaml-json.ts into JSON text first (off the main thread
 * when `prepareSpecText` ran before; see there for what a document may
 * contain), so everything below sees one form. The size limit is the owner's
 * (Settings → Resources, `resourceLimits().specBytes`).
 */

export type OpenApiDocument = JsonObject & {
  openapi: string
  paths: JsonObject
}

export { countNodes }

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").trim().slice(0, 300)
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
}

/** The error for a schema past the owner's limit. */
export function specTooLarge(maxBytes = resourceLimits().specBytes) {
  return invalid(
    `That schema is larger than ${megabytes(maxBytes)}, the most PCP reads (Settings → Resources).`,
  )
}

function cleaned(raw: string): string {
  return raw.replace(/^﻿/, "").trim()
}

/** Nodes a schema, or a schema with its edits, may have. */
export function specNodeLimit(): number {
  // GitHub's 14 MB description has 275,000 nodes: about 50 bytes each, so 16 is generous.
  return Math.max(MAX_SPEC_NODES, Math.floor(resourceLimits().specBytes / 16))
}

function checkSize(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > resourceLimits().specBytes) {
    throw specTooLarge()
  }
}

/** YAML schemas already turned into JSON text: the last two, for ten minutes. */
const READY_MAX = 2
const READY_TTL_MS = 10 * 60_000
const ready = new Map<string, { json: string; at: number }>()

function readyJson(text: string): string | null {
  const found = ready.get(text)

  if (!found) {
    return null
  }

  if (Date.now() - found.at > READY_TTL_MS) {
    ready.delete(text)
    return null
  }

  return found.json
}

function remember(text: string, json: string): void {
  ready.delete(text)
  ready.set(text, { json, at: Date.now() })

  while (ready.size > READY_MAX) {
    ready.delete(ready.keys().next().value!)
  }
}

/**
 * Texts `prepareSpecText` refused (over the memory or time it may spend,
 * or not YAML): a later parse of the same text refuses too, instead of
 * reading it here on the main thread without those bounds.
 */
const refused = new Map<string, unknown>()

/** Forgets what `prepareSpecText` kept (tests). */
export function forgetPreparedSpecs(): void {
  ready.clear()
  refused.clear()
}

function yamlFailure(error: unknown): never {
  if (error instanceof YamlTooLarge) {
    throw invalid(
      "The schema is too large once its anchors and aliases are expanded, or needs more memory than PCP may spend reading it (Settings → Resources).",
    )
  }

  if (isPcpError(error)) {
    throw error
  }

  throw invalid(`The schema could not be read as JSON or YAML: ${short(error)}`)
}

/**
 * Reads YAML schema text ahead of `parseSpecText`, in a worker thread, so
 * PCP stays responsive while a large one is read and the parse that follows
 * takes the JSON it made. Call it where schema text arrives, in async code;
 * JSON text needs nothing. It refuses a text past the owner's limit at once.
 */
export async function prepareSpecText(raw: string): Promise<void> {
  checkSize(raw)
  const text = cleaned(raw)

  if (!text || text.startsWith("{") || readyJson(text) !== null) {
    return
  }

  try {
    remember(
      text,
      await convertInWorker(text, {
        maxNodes: specNodeLimit(),
        specBytes: resourceLimits().specBytes,
      }),
    )
  } catch (error) {
    refused.set(text, error)

    while (refused.size > READY_MAX) {
      refused.delete(refused.keys().next().value!)
    }

    yamlFailure(error)
  }
}

export function parseSpecText(raw: string): OpenApiDocument {
  checkSize(raw)
  const text = cleaned(raw)

  if (!text) {
    throw invalid("The schema is empty.")
  }

  let value: unknown

  try {
    if (text.startsWith("{")) {
      value = JSON.parse(text)
    } else {
      let json = readyJson(text)

      if (json === null && refused.has(text)) {
        yamlFailure(refused.get(text))
      }

      if (json === null) {
        // Not prepared: read here, on this thread.
        json = convertInline(text, specNodeLimit())
        remember(text, json)
      }

      value = JSON.parse(json)
    }
  } catch (error) {
    if (error instanceof YamlTooLarge || error instanceof YamlUnreadable) {
      yamlFailure(error)
    }

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
