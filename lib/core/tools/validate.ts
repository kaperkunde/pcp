import {
  validate as kitValidate,
  type StringPlaceholder,
  type ValidateOptions as KitValidateOptions,
} from "@kaperkunde/mcp"

/**
 * The one check of a value against a JSON Schema (2020-12, and the drafts
 * before it as an MCP server writes them) is @kaperkunde/mcp's validate:
 * every argument that reaches a tool, PCP's own (define.ts) and those of a
 * execute or a run_code program's pcp.call against the inputSchema the
 * server or the API declared, before anything runs or the owner is asked.
 * Bounded, refusing a reference to another document (PCP never fetches one),
 * and leaving a pattern that could take exponential time to the tool.
 *
 * What is PCP's here is its two placeholders. A kept result's handle
 * ({"$result": id}, result-handles.ts) stands for a string PCP fills in
 * later, so it passes wherever a string may go, its length and pattern
 * unknown until then. {"$secret": name} passes only where `secretAt` says
 * the rules let one in (a wrapper's binding, the browser's type text), and
 * only where a string may go.
 */

export {
  argumentsRefusal,
  riskyPattern,
  sameJson,
  zodProblems,
  type InvalidHint,
} from "@kaperkunde/mcp"

export type ValidateOptions = Omit<KitValidateOptions, "placeholders"> & {
  /** A kept result's handle stands for a string. True by default. */
  handles?: boolean
  /** Where, by JSON Pointer, {"$secret": name} may stand for a string. */
  secretAt?: (pointer: string) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A kept result's handle, as result-handles.ts parseHandle reads one. */
export function isResultHandle(value: unknown): boolean {
  if (!isRecord(value) || typeof value.$result !== "string") {
    return false
  }

  const keys = Object.keys(value)

  return (
    value.$result.length > 0 &&
    value.$result.length <= 64 &&
    keys.every((key) => key === "$result" || key === "as") &&
    (value.as === undefined || value.as === "text" || value.as === "base64")
  )
}

/**
 * {"$secret": name}, a secret's placeholder (wrappers/placeholders.ts), with
 * "part" ("password" or "username") if it says which.
 */
function isSecretPlaceholder(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.$secret === "string" &&
    Object.keys(value).every((key) => key === "$secret" || key === "part") &&
    (value.part === undefined ||
      value.part === "password" ||
      value.part === "username")
  )
}

/** A kept result's handle, which stands for a string anywhere. */
export const RESULT_HANDLE: StringPlaceholder = {
  matches: isResultHandle,
  name: "a kept result's handle",
}

/** PCP's placeholders, as @kaperkunde/mcp takes them. */
export function placeholdersFor({
  handles = true,
  secretAt,
}: Pick<ValidateOptions, "handles" | "secretAt">): StringPlaceholder[] {
  return [
    ...(handles ? [RESULT_HANDLE] : []),
    ...(secretAt
      ? [{ matches: isSecretPlaceholder, allowedAt: secretAt }]
      : []),
  ]
}

/**
 * What is wrong with a value against its schema, one line per problem:
 * empty when it fits.
 */
export function validate(
  schema: unknown,
  value: unknown,
  { handles, secretAt, ...options }: ValidateOptions = {},
): string[] {
  return kitValidate(schema, value, {
    ...options,
    placeholders: placeholdersFor({ handles, secretAt }),
  })
}
