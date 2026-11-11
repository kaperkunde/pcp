import type { CallToolResult } from "@modelcontextprotocol/server"

import { MAX_STRUCTURED_CHARS } from "./openapi/limits"
import { makeRedactor } from "./openapi/redact"

/**
 * A tool answer PCP writes itself from a value: the JSON as text, and as
 * structured content when it is small enough, whatever JSON value it is
 * (MCP 2026-07-28 takes any; the SDK wraps a non-object for a client on
 * an older revision). Every string goes through the redactor first, so a
 * credential an upstream echoed never reaches the assistant.
 */
export function jsonToolResult(
  value: unknown,
  { redact = [] }: { redact?: string[] } = {},
): CallToolResult {
  const scrub = makeRedactor(redact)
  const clean = scrub.value(value)
  const text = scrub.text(JSON.stringify(clean, null, 2))

  return {
    content: [{ type: "text", text }],
    ...(JSON.stringify(clean).length <= MAX_STRUCTURED_CHARS
      ? { structuredContent: clean as Record<string, unknown> }
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
