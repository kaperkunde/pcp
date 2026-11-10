import {
  ownerLinkIn,
  serveTool as kitServeTool,
  type CallLine as KitCallLine,
  type ServeEvent,
  type ServeOptions,
} from "@kaperkunde/mcp"
import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server"

import { withLogNote, type LogNote } from "../request-log"
import { publishedSchema, type Tool } from "./define"
import {
  expectedPcpError,
  INTERNAL_MESSAGE,
  NOTES_META_KEY,
  PCP_META,
  type NeedsOwner,
} from "./outcome"
import { RESULT_HANDLE } from "./validate"

/**
 * How a call of a tool defined with defineTool runs is @kaperkunde/mcp's
 * serveTool: old names renamed, the arguments checked, the run, its outcome
 * mapped to a result and checked against the output the tool declares, and
 * its line in the request log. What PCP adds:
 *
 * - its meta keys, its words for a fault ("Something went wrong inside
 *   PCP."), and a PcpError as a refusal in its own words;
 * - a kept result's handle standing for a string in the arguments;
 * - its permission links recognised in an answer passed on, and marked as
 *   needsOwner's are (permissionLinkIn);
 * - the request log's note for the call (withLogNote: an ask, a secret
 *   typed);
 * - a lead in front of the answer once it is made (what the session has
 *   not heard of yet: the owner's answers to its requests), which the
 *   package has no hook for.
 */

export {
  ARGUMENTS_DID_NOT_FIT,
  fitForClients,
  TOOL_REPORTED_ERROR,
} from "@kaperkunde/mcp"

/** The few words of a permission request's link. */
export const PERMISSION_LINK_LABEL = "Answer the request in PCP"

export type CallLine = KitCallLine<LogNote>

export type ServeHooks = {
  /** PCP's address, to know its permission links by. */
  publicUrl: string
  /** Writes the call's line in the request log. */
  log: (line: CallLine) => void
  /**
   * A text to put in front of the answer, after the tool ran (what the
   * session has not heard of yet: the owner's answers to its requests);
   * null for none. Its failure costs the answer nothing.
   */
  lead?: () => Promise<string | null>
}

/**
 * The permission request a result asks the owner about: its link, the last
 * line of its text, on PCP's own address. Null when it asks nothing.
 */
export function permissionLinkIn(
  result: CallToolResult,
  publicUrl: string,
): NeedsOwner | null {
  return ownerLinkIn(result, {
    prefix: `${publicUrl.replace(/\/+$/, "")}/permissions/`,
    label: PERMISSION_LINK_LABEL,
  }) as NeedsOwner | null
}

/** What PCP's server log says of what no client hears. */
function report(event: ServeEvent): void {
  switch (event.kind) {
    case "threw":
      console.error("[gateway] tool failed", {
        tool: event.tool,
        error: event.error,
      })
      break
    case "output_mismatch":
      console.error("[gateway] answer does not fit the output schema", {
        tool: event.tool,
        problems: event.problems,
      })
      break
    case "finished_late":
      console.info(
        `[gateway] ${event.tool} finished after answering that it was still going: ${event.ok ? "done" : `failed (${event.code ?? "error"})`}`,
      )
  }
}

/** The package's options for PCP's hooks. */
function serveOptions(hooks: ServeHooks): ServeOptions<unknown, LogNote> {
  return {
    meta: PCP_META,
    expectedError: expectedPcpError,
    internalMessage: INTERNAL_MESSAGE,
    placeholders: [RESULT_HANDLE],
    ownerLink: (result) => permissionLinkIn(result, hooks.publicUrl),
    log: hooks.log,
    scope: withLogNote,
    report,
  }
}

/**
 * A text of its own in front of a served result. structuredContent stays
 * as it is, and carries the text in `_meta` as a renamed argument's note
 * does; in front, so an answer that asks the owner still ends with its
 * link.
 */
export function withLeadText(
  result: CallToolResult,
  lead: string,
): CallToolResult {
  const notes = result._meta?.[NOTES_META_KEY]

  return {
    ...result,
    content: [{ type: "text", text: lead }, ...result.content],
    ...(result.structuredContent !== undefined
      ? {
          _meta: {
            ...result._meta,
            [NOTES_META_KEY]: [
              lead,
              ...(Array.isArray(notes) ? (notes as string[]) : []),
            ],
          },
        }
      : {}),
  }
}

/** One call of a tool, start to end. */
export async function serveTool(
  tool: Tool,
  sent: unknown,
  request: ServerContext,
  hooks: ServeHooks,
): Promise<CallToolResult> {
  const result = await kitServeTool(tool, sent, request, serveOptions(hooks))

  if (!hooks.lead) {
    return result
  }

  const lead = await hooks.lead().catch((error: unknown) => {
    console.error("[gateway] an answer's lead failed", {
      tool: tool.name,
      error,
    })
    return null
  })

  return lead ? withLeadText(result, lead) : result
}

/**
 * What a call of a registered tool may become before it is served: another
 * tool with its own arguments (execute_<tier> naming one of PCP's own tools,
 * gateway.ts), or null to serve the tool itself. A note goes in front of the
 * answer (a client prefix read as the bare name).
 */
export type Dispatch = (
  sent: unknown,
) => { tool: Tool; args: unknown; note?: string | null } | null

/** How a tool is registered beyond the package's own. */
export type RegisterOptions = {
  /**
   * A line in front of every answer, for a name kept only for a while
   * (docs/breaking-changes.md): what to call instead.
   */
  note?: string
  /** What a call may become instead (Dispatch). */
  dispatch?: Dispatch
}

/**
 * Registers a tool on an MCP server, served as above: the package's
 * registerTool, but for its handler, which is PCP's serveTool so the lead
 * goes in front of the answer.
 */
export function registerTool(
  server: McpServer,
  tool: Tool,
  hooks: ServeHooks,
  { note, dispatch }: RegisterOptions = {},
): void {
  const output = tool.output
    ? publishedSchema(() => tool.outputSchema()!)
    : undefined

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: publishedSchema(() => tool.inputSchema()),
      ...(output ? { outputSchema: output } : {}),
      annotations: tool.annotations,
      ...(tool.meta ? { _meta: tool.meta } : {}),
    },
    async (args, ctx) => {
      const routed = dispatch?.(args) ?? null
      const result = routed
        ? await serveTool(routed.tool, routed.args, ctx, hooks)
        : await serveTool(tool, args, ctx, hooks)
      const lead = [note, routed?.note].filter(
        (line): line is string => typeof line === "string" && line !== "",
      )

      return lead.length > 0 ? withLeadText(result, lead.join("\n")) : result
    },
  )
}

/**
 * What tools/list answers: these tools only, as registerTool publishes
 * them. Every other registered tool still answers a call by its name (one
 * kept for a while, or one reached through another), unlisted. Called
 * once the tools are registered, it takes the place of the SDK's listing.
 */
export function listOnly(server: McpServer, tools: Tool[]): void {
  server.server.setRequestHandler("tools/list", () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema() as {
        type: "object"
        [key: string]: unknown
      },
      ...(tool.output
        ? {
            outputSchema: tool.outputSchema() as {
              type: "object"
              [key: string]: unknown
            },
          }
        : {}),
      annotations: tool.annotations,
      ...(tool.meta ? { _meta: tool.meta } : {}),
    })),
  }))
}
