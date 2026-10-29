import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server"

import { isPcpError } from "../errors"
import { withLogNote, type LogNote } from "../request-log"
import {
  applyAliases,
  publishedSchema,
  type LogNames,
  type Tool,
} from "./define"
import {
  errorOutcome,
  passOn,
  toCallToolResult,
  toolError,
  type NeedsOwner,
  type Outcome,
} from "./outcome"
import { argumentsRefusal, validate } from "./validate"

/**
 * How a call of a tool defined with defineTool runs, from the arguments as
 * the client sent them to the result it gets back, with its line in the
 * request log: old names renamed, the arguments checked, the run, and its
 * outcome mapped to a result.
 */

/** What the request log keeps for arguments that did not fit. */
export const ARGUMENTS_DID_NOT_FIT =
  "The arguments did not fit the tool's input schema."
/** What it keeps for a refusal it may not quote, or another tool's error. */
export const TOOL_REPORTED_ERROR = "The tool reported an error."
/** The few words of a permission request's link. */
export const PERMISSION_LINK_LABEL = "Answer the request in PCP"

export type CallLine = {
  tool: string
  names: LogNames
  ok: boolean
  ms: number
  /** Why it failed, in words the log may keep. */
  error?: string
  /** What the code under the call noted: an ask, a secret typed. */
  note: LogNote
}

export type ServeHooks = {
  /** PCP's address, to know its permission links by. */
  publicUrl: string
  /** Writes the call's line in the request log. */
  log: (line: CallLine) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * The permission request a result asks the owner about: its link, the last
 * line of its text, on PCP's own address. Null when it asks nothing.
 */
export function permissionLinkIn(
  result: CallToolResult,
  publicUrl: string,
): NeedsOwner | null {
  const texts = result.content.filter((part) => part.type === "text")
  const last = texts.at(-1)?.text.trimEnd().split("\n").at(-1)?.trim() ?? ""
  const base = publicUrl.replace(/\/+$/, "")
  const prefix = `${base}/permissions/`
  // The link alone, or as a Markdown link: [label](url), whose label it
  // keeps (linkLastText's: the request's title).
  const markdown = /^\[([^\]]*)\]\((.*)\)$/.exec(last)
  const url = markdown?.[2] ?? last
  const label = markdown?.[1]?.trim() || PERMISSION_LINK_LABEL

  if (!url.startsWith(prefix) || /\s/.test(url)) {
    return null
  }

  let request: string

  try {
    request = decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }

  return request && !request.includes("/")
    ? {
        kind: "needs_owner",
        reason: "permission",
        url,
        label,
        request,
      }
    : null
}

/** An answer made elsewhere that asks the owner, marked as needsOwner's are. */
function markOwner(outcome: Outcome, publicUrl: string): Outcome {
  if (
    outcome.type !== "result" ||
    outcome.result.isError === true ||
    outcome.result.structuredContent !== undefined
  ) {
    return outcome
  }

  const owner = permissionLinkIn(outcome.result, publicUrl)

  return owner
    ? passOn({ ...outcome.result, structuredContent: owner })
    : outcome
}

/** The words a zod refinement found wrong, for one that JSON Schema lacks. */
function zodProblems(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string[] {
  return issues.map((issue) =>
    issue.path.length > 0
      ? `"${issue.path.map(String).join("/")}": ${issue.message}`
      : issue.message,
  )
}

/** What a tool names for its log line, from arguments not yet checked. */
function logNames(tool: Tool, args: Record<string, unknown>): LogNames {
  try {
    const names = tool.log?.(args) ?? {}

    return Object.fromEntries(
      Object.entries(names).filter(([, value]) => typeof value === "string"),
    )
  } catch {
    return {}
  }
}

/** One call of a tool, start to end. */
export function serveTool(
  tool: Tool,
  sent: unknown,
  request: ServerContext,
  hooks: ServeHooks,
): Promise<CallToolResult> {
  return withLogNote(async (note) => {
    const started = Date.now()
    const names: LogNames = {}
    let notes: string[] = []
    let outcome: Outcome

    try {
      const renamed = applyAliases(isRecord(sent) ? sent : {}, tool.aliases)
      notes = renamed.notes
      Object.assign(names, logNames(tool, renamed.args))

      const problems = renamed.conflict
        ? [renamed.conflict]
        : validate(tool.inputSchema(), renamed.args)

      if (problems.length > 0) {
        outcome = toolError(
          argumentsRefusal(tool.name, problems, {
            lead: "nothing was done",
            hint: tool.invalidHint?.(renamed.args),
          }),
          { code: "invalid_arguments", logAs: ARGUMENTS_DID_NOT_FIT },
        )
      } else {
        const parsed = tool.input.safeParse(renamed.args)

        outcome = parsed.success
          ? await tool.run(parsed.data, {
              signal: request.mcpReq.signal,
              request,
              logAs: (more) => Object.assign(names, more),
            })
          : toolError(
              argumentsRefusal(tool.name, zodProblems(parsed.error.issues), {
                lead: "nothing was done",
              }),
              { code: "invalid_arguments", logAs: ARGUMENTS_DID_NOT_FIT },
            )
      }
    } catch (error) {
      if (!isPcpError(error)) {
        console.error("[gateway] tool failed", { tool: tool.name, error })
      }

      outcome = errorOutcome(error)
    }

    outcome = markOwner(outcome, hooks.publicUrl)
    let result = toCallToolResult(outcome, {
      structured: tool.output !== undefined,
      notes,
    })

    // What a tool declares it answers, it answers: anything else is a bug.
    // Checked against the schema as published, by the same check as
    // arguments: an extra key is as wrong as a missing one.
    if (tool.output && result.isError !== true) {
      const problems = validate(tool.outputSchema(), result.structuredContent, {
        schemaName: "outputSchema",
        whole: "The answer",
        arguments: false,
        handles: false,
      })

      if (problems.length > 0) {
        console.error("[gateway] answer does not fit the output schema", {
          tool: tool.name,
          problems,
        })
        outcome = toolError("Something went wrong inside PCP.", {
          code: "internal",
        })
        result = toCallToolResult(outcome, { notes })
      }
    }

    const failed = result.isError === true

    hooks.log({
      tool: tool.name,
      names,
      ok: !failed,
      ms: Date.now() - started,
      ...(failed
        ? {
            error:
              outcome.type === "error"
                ? (outcome.logAs ??
                  (tool.quiet
                    ? TOOL_REPORTED_ERROR
                    : outcome.message.slice(0, 200)))
                : TOOL_REPORTED_ERROR,
          }
        : {}),
      note,
    })

    return result
  })
}

/** Registers a tool on an MCP server, served as above. */
export function registerTool(
  server: McpServer,
  tool: Tool,
  hooks: ServeHooks,
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
    },
    (args, ctx) => serveTool(tool, args, ctx, hooks),
  )
}
