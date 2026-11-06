import {
  argumentsResult as kitArgumentsResult,
  defineInnerTool as kitDefineInnerTool,
  familyError as kitFamilyError,
  type ArgumentCheck,
  type InnerTool as KitInnerTool,
  type InnerToolSpec,
} from "@kaperkunde/mcp"
import type { CallToolResult } from "@modelcontextprotocol/server"
import type { z } from "zod"

import { isPcpError } from "../errors"
import { ERROR_META_KEY, PCP_META, type ToolErrorCode } from "./outcome"
import { placeholdersFor, type ValidateOptions } from "./validate"

/**
 * The tools of PCP's own families behind call_tool (the browser, mail and
 * calendar accounts, SSH servers, services, storage folders), defined
 * through @kaperkunde/mcp's defineInnerTool, the same interface as PCP's own
 * tools at /mcp (define.ts), and checked by the same validator:
 *
 *   defineInnerTool({ name, title, description, input, output?,
 *                     annotations, aliases?, retired?, synonyms?, rules? })
 *
 * They are not served at /mcp: the gateway reaches them through call_tool
 * and run_code, a wrapper's program through its calls, and each family runs
 * them with what it holds (a credential, a tab). So an inner tool has no
 * `run`; it publishes its schemas for the catalogue and checks a call's
 * arguments (`check`), which every way in calls before anything connects or
 * the owner is asked (lib/core/call-arguments.ts), and the family once
 * more before it runs.
 *
 * What is PCP's here: `check` takes PCP's placeholders (a kept result's
 * handle anywhere a string goes unless `handles` is false, a secret where
 * `secretAt` lets one in), a refusal carries its code under "gg.pcp" with,
 * for browser_busy, when to try again (`retryAfterMs`), and a PcpError a
 * run threw is a refusal (`refusalOf`).
 */

export {
  atLeastOne,
  exactlyOne,
  notTogether,
  renameNote,
  textAnswer,
  withNotes,
  type ArgumentCheck,
  type ArgumentRule,
  type InnerToolSpec,
  type ListedTool,
  type Rename,
} from "@kaperkunde/mcp"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = z.ZodObject<any>

export type CheckOptions = Pick<ValidateOptions, "secretAt" | "handles">

export type InnerTool<I extends AnyObject = AnyObject> = Omit<
  KitInnerTool<I>,
  "check"
> & {
  /**
   * A call's arguments, checked: old names renamed, the schema, the rules,
   * then zod's refinements. The arguments as the tool reads them, or every
   * problem in PCP's words.
   */
  check(args: unknown, options?: CheckOptions): ArgumentCheck<z.output<I>>
}

export function defineInnerTool<I extends AnyObject>(
  spec: InnerToolSpec<I>,
): InnerTool<I> {
  const tool = kitDefineInnerTool(spec)

  return {
    ...tool,
    check: (args, options = {}) =>
      tool.check(args, { placeholders: placeholdersFor(options) }),
  }
}

/** A refusal with its code: nothing was done. */
export function familyError(
  message: string,
  code: ToolErrorCode,
  {
    hint,
    notes = [],
    retryAfterMs,
  }: { hint?: string; notes?: string[]; retryAfterMs?: number } = {},
): CallToolResult {
  const result = kitFamilyError(message, code, { hint, notes, meta: PCP_META })

  if (retryAfterMs === undefined) {
    return result
  }

  const error = result._meta?.[ERROR_META_KEY] as
    Record<string, unknown> | undefined

  return {
    ...result,
    _meta: {
      ...result._meta,
      [ERROR_META_KEY]: {
        ...error,
        retryAfterMs: Math.max(0, Math.round(retryAfterMs)),
      },
    },
  }
}

/** Arguments that do not fit: every problem, and that nothing was done. */
export function argumentsResult(
  label: string,
  problems: string[],
  options: { hint?: string; notes?: string[] } = {},
): CallToolResult {
  return kitArgumentsResult(label, problems, { ...options, meta: PCP_META })
}

/**
 * A PcpError a family's run threw, as its answer: arguments it found wrong
 * once it could look (a range the wrong way round) and other refusals are
 * tool errors with their code. Null for a failure on the way to the server
 * ("upstream") or a sign-in it needs ("unauthorized"), which the caller
 * throws on: the gateway connects the one and says the other may have gone
 * through.
 */
export function refusalOf(
  error: unknown,
  label: string,
  notes: string[] = [],
): CallToolResult | null {
  if (
    !isPcpError(error) ||
    error.code === "upstream" ||
    error.code === "unauthorized"
  ) {
    return null
  }

  return error.code === "validation"
    ? argumentsResult(label, [error.message], { notes })
    : familyError(error.message, error.code, { notes })
}
