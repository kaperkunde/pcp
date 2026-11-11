import type { McpServer } from "@/lib/generated/prisma/client"

import { tabHint, tabProblem } from "./browser/call"
import { browserToolSpec } from "./browser/tools"
import { calendarToolSpec } from "./caldav/tools"
import type { VaultContext } from "./context"
import { mailTool } from "./mail/tools"
import {
  isCalendarKind,
  isMailKind,
  isServiceKind,
  isSshKind,
  isStorageKind,
} from "./servers"
import { serviceTool } from "./services/tools"
import { runCommandTool, RUN_COMMAND } from "./ssh/tools"
import { storageTool } from "./storage/tools"
import { applyAliases } from "./tools/define"
import type { InnerTool, Rename } from "./tools/family"
import { answerHint } from "./tools/answer-hint"
import { validate } from "./tools/validate"

/**
 * The one check of a call's arguments before anything runs or the owner is
 * asked, for every way a call reaches a tool: execute_<tier>,
 * run_<tier>'s pcp.call, a wrapper's program and a
 * browser flow (wrappers/run.ts). A tool of PCP's own families (the
 * browser, mail and calendar accounts, SSH servers, services, storage
 * roots) is checked by
 * its definition (tools/family.ts): old argument names renamed, its rules,
 * what only zod can say. Any other tool (an MCP server's, an API
 * endpoint's, a wrapper's) against the inputSchema its catalogue row
 * holds, by the same validator (tools/validate.ts).
 */

export type CallArgumentCheck =
  | {
      fits: true
      /** The arguments with old names renamed, handles left in place. */
      args: Record<string, unknown>
      /** "x was renamed to y; use y." for each old name used. */
      notes: string[]
      renames: Rename[]
    }
  | {
      fits: false
      problems: string[]
      notes: string[]
      renames: Rename[]
      /** What the family adds to the refusal (the browser's tabs). */
      hint?: string
    }

/** A family's tool by its server's kind and its name; undefined for others. */
export function familyTool(
  server: Pick<McpServer, "kind">,
  toolName: string,
): InnerTool | undefined {
  if (server.kind === "browser") {
    return browserToolSpec(toolName)
  }

  if (isMailKind(server.kind)) {
    return mailTool(server.kind, toolName)
  }

  if (isCalendarKind(server.kind)) {
    return calendarToolSpec(toolName)
  }

  if (isSshKind(server.kind)) {
    return toolName === RUN_COMMAND ? runCommandTool() : undefined
  }

  if (isServiceKind(server.kind)) {
    return serviceTool(toolName)
  }

  if (isStorageKind(server.kind)) {
    return storageTool(toolName)
  }

  return undefined
}

export async function checkCallArguments(
  server: Pick<McpServer, "kind">,
  toolName: string,
  /** The catalogue row's inputSchema, as JSON text. */
  storedSchema: string | null | undefined,
  args: Record<string, unknown>,
  {
    secretAt,
    tabs,
  }: {
    /** Where, by JSON Pointer, {"$secret": name} may stand for a string. */
    secretAt?: (pointer: string) => boolean
    /** Whose tabs a browser refusal about the tab lists. */
    tabs?: {
      ctx: Pick<VaultContext, "vaultId">
      tokenId: string
      publicUrl: string
    }
  } = {},
): Promise<CallArgumentCheck> {
  const tool = familyTool(server, toolName)

  if (tool) {
    const sent = { ...args }
    const checked = tool.check(sent, secretAt ? { secretAt } : {})

    if (checked.fits) {
      return {
        fits: true,
        // As sent, renamed: a handle stays a handle until upstream.ts.
        args: renamedArgs(sent, checked.renames),
        notes: checked.notes,
        renames: checked.renames,
      }
    }

    const hint =
      server.kind === "browser" && tabs && tabProblem(checked.problems)
        ? await tabHint(tabs.ctx, tabs.tokenId, tabs.publicUrl)
        : undefined

    const full = [hint, answerHint(sent, checked.problems)]
      .filter(Boolean)
      .join("\n")

    return { ...checked, ...(full ? { hint: full } : {}) }
  }

  let schema: unknown

  try {
    schema = JSON.parse(storedSchema ?? "")
  } catch {
    // A schema PCP cannot read checks nothing; the tool decides.
    return { fits: true, args, notes: [], renames: [] }
  }

  const problems = validate(schema, args, secretAt ? { secretAt } : {})

  if (problems.length === 0) {
    return { fits: true, args, notes: [], renames: [] }
  }

  const hint = answerHint(args, problems)

  return {
    fits: false,
    problems,
    notes: [],
    renames: [],
    ...(hint ? { hint } : {}),
  }
}

/**
 * The arguments with each old name a call used renamed, as the tool's check
 * did, but with every value as it was sent (zod's parse has not touched
 * them, and a kept result's handle is still one).
 */
function renamedArgs(
  sent: Record<string, unknown>,
  renames: Rename[],
): Record<string, unknown> {
  return applyAliases(
    sent,
    Object.fromEntries(renames.map(({ from, to }) => [from, to])),
  ).args
}
