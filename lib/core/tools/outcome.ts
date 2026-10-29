import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import { isPcpError, type PcpErrorCode } from "../errors"

/**
 * What a tool's run comes to, before it is an MCP result. Every tool PCP
 * exposes answers one of these ways, mapped to a result in one place
 * (toCallToolResult):
 *
 * - ok(value): it did what it was asked. A tool that declares an output
 *   schema gets `value` as structuredContent, with its JSON as the text; a
 *   tool that answers in prose passes the text as the value.
 * - toolError(message, { code, hint }): it did not, and says why. Sent with
 *   isError, the message (and the hint after it) as the text and the code
 *   in `_meta["gg.pcp/error"]`, so a PcpError's code is never lost. An
 *   assistant reads it and tries again; a protocol error is only for an
 *   unknown tool or a malformed request, which the SDK answers.
 * - needsOwner(owner, text): it waits for the owner: a permission request
 *   or a server to connect. The text ends with the link the assistant hands
 *   over (connect.ts linkLastText); structuredContent carries the same as
 *   NEEDS_OWNER, on every tool, declared in the output schema of the tools
 *   that have one.
 * - passOn(result): an answer made elsewhere (an upstream tool's, a
 *   permission request's), passed on as it is. A permission request in it
 *   is recognised by its link and marked as needsOwner's are (serve.ts).
 */

/** Why a tool did not do what it was asked, for a client to act on. */
export type ToolErrorCode =
  | PcpErrorCode
  /** The arguments do not fit the tool's input schema; nothing ran. */
  | "invalid_arguments"
  /** Too many calls of this kind in a short time; nothing ran. */
  | "rate_limited"
  /** A fault in PCP itself. */
  | "internal"

/** Where a failed result's code and hint are, in its `_meta`. */
export const ERROR_META_KEY = "gg.pcp/error"

/** A server as check_server and a connect link describe it. */
export const SERVER_STATE = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  connected: z.boolean(),
  status: z.string(),
  toolCount: z.number(),
})

export type ServerState = z.infer<typeof SERVER_STATE>

/** The links that connect a server: its page, and the sign-in it starts. */
export const CONNECT_LINKS = z.object({
  serverId: z.string(),
  slug: z.string(),
  name: z.string(),
  /** PCP's OAuth start route, which Connect on the server's page opens. */
  startUrl: z.string(),
  /** The server's page in PCP: Connect, or what to set up first. */
  pageUrl: z.string(),
})

export type ConnectLinks = z.infer<typeof CONNECT_LINKS>

/**
 * A call that waits for the owner, as structuredContent: the link to hand
 * over and what it is for. A permission request names its id, for
 * check_permission; a server to connect names its links, for check_server.
 */
export const NEEDS_OWNER = z.object({
  kind: z.literal("needs_owner"),
  reason: z.enum(["permission", "connect"]),
  /** The page the owner opens, signed in to PCP. */
  url: z.string(),
  /** A few words for the link. */
  label: z.string(),
  /** The permission request's id, for check_permission. */
  request: z.string().optional(),
  connect: CONNECT_LINKS.optional(),
  server: SERVER_STATE.optional(),
})

export type NeedsOwner = z.infer<typeof NEEDS_OWNER>

export type Outcome =
  | { type: "ok"; value: unknown; text?: string }
  | {
      type: "error"
      message: string
      code: ToolErrorCode
      hint?: string
      /** What the request log keeps instead of the message. */
      logAs?: string
    }
  | { type: "needs_owner"; owner: NeedsOwner; text: string }
  | { type: "result"; result: CallToolResult }

/**
 * It did what it was asked. `text` replaces the JSON of a structured
 * value, for a value whose text is long or better said otherwise.
 */
export function ok(value: unknown, { text }: { text?: string } = {}): Outcome {
  return { type: "ok", value, ...(text !== undefined ? { text } : {}) }
}

/** It did not, and says why; nothing it was asked to do happened. */
export function toolError(
  message: string,
  {
    code = "validation",
    hint,
    logAs,
  }: { code?: ToolErrorCode; hint?: string; logAs?: string } = {},
): Outcome {
  return {
    type: "error",
    message,
    code,
    ...(hint ? { hint } : {}),
    ...(logAs ? { logAs } : {}),
  }
}

/** It waits for the owner; `text` ends with the link to hand over. */
export function needsOwner(owner: NeedsOwner, text: string): Outcome {
  return { type: "needs_owner", owner, text }
}

/** An answer made elsewhere, passed on as it is. */
export function passOn(result: CallToolResult): Outcome {
  return { type: "result", result }
}

/** What a thrown error comes to: a PcpError's own words, or PCP's fault. */
export function errorOutcome(error: unknown): Outcome {
  return isPcpError(error)
    ? toolError(error.message, { code: error.code })
    : toolError("Something went wrong inside PCP.", { code: "internal" })
}

/** A line in front of an outcome's text: a renamed argument's note, say. */
export function withLead(lead: string, outcome: Outcome): Outcome {
  switch (outcome.type) {
    case "error":
      return { ...outcome, message: `${lead}\n\n${outcome.message}` }
    case "needs_owner":
      return { ...outcome, text: `${lead}\n\n${outcome.text}` }
    case "result": {
      const [first, ...rest] = outcome.result.content

      return first?.type === "text"
        ? passOn({
            ...outcome.result,
            content: [{ ...first, text: `${lead}\n\n${first.text}` }, ...rest],
          })
        : outcome
    }
    case "ok":
      return typeof outcome.value === "string" && outcome.text === undefined
        ? { ...outcome, value: `${lead}\n\n${outcome.value}` }
        : outcome
  }
}

/** A value's JSON as an answer's text. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 1)
}

/**
 * The MCP result for an outcome. `structured` says the tool declares an
 * output schema: its ok values are structuredContent, with their JSON as
 * text. `notes` go first, each a text of its own (a renamed argument).
 */
export function toCallToolResult(
  outcome: Outcome,
  {
    structured = false,
    notes = [],
  }: { structured?: boolean; notes?: string[] } = {},
): CallToolResult {
  const lead = notes.map((note) => ({ type: "text" as const, text: note }))
  let result: CallToolResult

  switch (outcome.type) {
    case "ok": {
      const text =
        outcome.text ??
        (typeof outcome.value === "string" && !structured
          ? outcome.value
          : jsonText(outcome.value))

      result = {
        content: [{ type: "text", text }],
        ...(structured ? { structuredContent: outcome.value as never } : {}),
      }
      break
    }
    case "error":
      result = {
        content: [
          {
            type: "text",
            text: outcome.hint
              ? `${outcome.message}\n\n${outcome.hint}`
              : outcome.message,
          },
        ],
        isError: true,
        _meta: {
          [ERROR_META_KEY]: {
            code: outcome.code,
            ...(outcome.hint ? { hint: outcome.hint } : {}),
          },
        },
      }
      break
    case "needs_owner":
      result = {
        content: [{ type: "text", text: outcome.text }],
        structuredContent: outcome.owner,
      }
      break
    case "result":
      result = outcome.result
  }

  return lead.length > 0
    ? { ...result, content: [...lead, ...result.content] }
    : result
}

/** The error code a result carries, when PCP wrote it. */
export function errorCodeOf(result: CallToolResult): ToolErrorCode | undefined {
  const meta = result._meta?.[ERROR_META_KEY] as { code?: unknown } | undefined

  return typeof meta?.code === "string"
    ? (meta.code as ToolErrorCode)
    : undefined
}
