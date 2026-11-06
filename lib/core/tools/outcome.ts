import {
  errorCodeOf as kitErrorCodeOf,
  errorOutcome as kitErrorOutcome,
  metaKeys,
  needsOwner as kitNeedsOwner,
  needsOwnerSchema,
  toCallToolResult as kitToCallToolResult,
  toolError as kitToolError,
  type Outcome,
  type ResultOptions,
} from "@kaperkunde/mcp"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import { isPcpError, type PcpErrorCode } from "../errors"

/**
 * What a tool's run comes to, before it is an MCP result: @kaperkunde/mcp's
 * outcomes, with what is PCP's own. Every tool PCP exposes answers one of
 * these ways, mapped to a result in one place (toCallToolResult):
 *
 * - ok(value): it did what it was asked. A tool that declares an output
 *   schema gets `value` as structuredContent, with its JSON as the text; a
 *   tool that answers in prose passes the text as the value.
 * - toolError(message, { code, hint }): it did not, and says why. Sent with
 *   isError, the message (and the hint after it) as the text and the code
 *   in `_meta["gg.pcp/error"]`, so a PcpError's code is never lost. An
 *   assistant reads it and tries again; a protocol error is only for an
 *   unknown tool or a malformed request, which the SDK answers.
 * - needsOwner(owner, text): it waits for the owner: a permission request,
 *   a server to connect, files to upload, or something to set up first (a
 *   capability with no provider, capabilities/). The text ends with the
 *   link the assistant hands over, a markdown link labelled with `label`
 *   (owner-link.ts linkLastText); structuredContent carries the same as
 *   NEEDS_OWNER, on every tool, declared in the output schema of the tools
 *   that have one.
 * - passOn(result): an answer made elsewhere (an upstream tool's, a
 *   permission request's), passed on as it is. A permission request in it
 *   is recognised by its link and marked as needsOwner's are (serve.ts).
 *
 * What is PCP's here: its meta keys ("gg.pcp"), its error codes, its
 * reasons and links for the owner, and that a PcpError is a refusal in its
 * own words while anything else thrown is PCP's fault.
 */

export { jsonText, ok, passOn, withLead, type Outcome } from "@kaperkunde/mcp"

/** Why a tool did not do what it was asked, for a client to act on. */
export type ToolErrorCode =
  | PcpErrorCode
  /** The arguments do not fit the tool's input schema; nothing ran. */
  | "invalid_arguments"
  /** Too many calls of this kind in a short time; nothing ran. */
  | "rate_limited"
  /**
   * The call took longer than its timeout and was answered without waiting
   * further (the browser's timeout_ms); the message names the step and
   * whether what it was asked may have happened.
   */
  | "timeout"
  /**
   * The browser's tab (or the browser) has more work waiting than the call
   * would wait for; nothing ran. `retryAfterMs` says when to try again
   * (family.ts familyError).
   */
  | "browser_busy"
  /** A fault in PCP itself. */
  | "internal"

/** Where PCP's results keep their code and their notes, in `_meta`. */
export const PCP_META = metaKeys("gg.pcp")

/** Where a failed result's code and hint are, in its `_meta`. */
export const ERROR_META_KEY = PCP_META.error

/**
 * Where a structured answer's notes (a renamed argument) are, in its
 * `_meta`, beside their own text blocks: the output schema is closed.
 */
export const NOTES_META_KEY = PCP_META.notes

/** What PCP answers for a fault of its own; the error stays on the server. */
export const INTERNAL_MESSAGE = "Something went wrong inside PCP."

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
 * over and what it is for. `url` is the page the owner opens: signed in to
 * PCP, but for an upload link's, which the link alone opens. A permission
 * request names its id (`request`), for check_permission; a server to
 * connect names its links, for check_server; an upload link
 * (create_upload_link) its id, for check_upload; something to set up
 * (reason "setup") the capability it is for, whose tool to call again once
 * the owner has.
 */
export const NEEDS_OWNER = needsOwnerSchema({
  reason: z.enum(["permission", "connect", "upload", "setup"]),
  connect: CONNECT_LINKS.optional(),
  server: SERVER_STATE.optional(),
  /**
   * What the owner sets up (reason "setup"): a capability's id
   * (capabilities/list.ts), whose tool to call again afterwards.
   */
  capability: z.string().optional(),
  /** The upload link's id, for check_upload, and until when it takes files. */
  upload: z
    .object({ id: z.string(), maxFiles: z.number(), until: z.string() })
    .optional(),
})

export type NeedsOwner = z.infer<typeof NEEDS_OWNER>

/** It did not, and says why; nothing it was asked to do happened. */
export function toolError(
  message: string,
  options: { code?: ToolErrorCode; hint?: string; logAs?: string } = {},
): Outcome {
  return kitToolError(message, options)
}

/** It waits for the owner; `text` ends with the link to hand over. */
export function needsOwner(owner: NeedsOwner, text: string): Outcome {
  return kitNeedsOwner(owner, text)
}

/** A thrown PcpError as PCP's own words and code; undefined for a fault. */
export function expectedPcpError(
  error: unknown,
): { message: string; code: ToolErrorCode } | undefined {
  return isPcpError(error)
    ? { message: error.message, code: error.code }
    : undefined
}

/** What a thrown error comes to: a PcpError's own words, or PCP's fault. */
export function errorOutcome(error: unknown): Outcome {
  return kitErrorOutcome(error, {
    expectedError: expectedPcpError,
    internalMessage: INTERNAL_MESSAGE,
  })
}

/**
 * The MCP result for an outcome, with PCP's meta keys. `structured` says
 * the tool declares an output schema: its ok values are structuredContent,
 * with their JSON as text. `notes` go first, each a text of its own (a
 * renamed argument).
 */
export function toCallToolResult(
  outcome: Outcome,
  options: Omit<ResultOptions, "meta"> = {},
): CallToolResult {
  return kitToCallToolResult(outcome, { ...options, meta: PCP_META })
}

/** The error code a result carries, when PCP wrote it. */
export function errorCodeOf(result: CallToolResult): ToolErrorCode | undefined {
  return kitErrorCodeOf(result, PCP_META) as ToolErrorCode | undefined
}
