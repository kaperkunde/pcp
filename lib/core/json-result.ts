import type { CallToolResult } from "@modelcontextprotocol/server"

import { MAX_STRUCTURED_CHARS } from "./openapi/limits"
import { makeRedactor } from "./openapi/redact"

/**
 * A tool answer PCP writes itself from a value: the JSON as text, and as
 * structured content when it is small enough. Every string goes through
 * the redactor first, so a credential an upstream echoed never reaches the
 * assistant.
 */
export function jsonToolResult(
  value: unknown,
  { redact = [] }: { redact?: string[] } = {},
): CallToolResult {
  const scrub = makeRedactor(redact)
  const clean = scrub.value(value)
  const text = scrub.text(JSON.stringify(clean, null, 2))
  const structured =
    clean !== null && typeof clean === "object" && !Array.isArray(clean)
      ? (clean as Record<string, unknown>)
      : { value: clean }

  return {
    content: [{ type: "text", text }],
    ...(JSON.stringify(structured).length <= MAX_STRUCTURED_CHARS
      ? { structuredContent: structured }
      : {}),
  }
}

export function errorToolResult(
  message: string,
  { redact = [] }: { redact?: string[] } = {},
): CallToolResult {
  return {
    content: [{ type: "text", text: makeRedactor(redact).text(message) }],
    isError: true,
  }
}
