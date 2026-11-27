import { PROGRAM_TOOLS, type ProgramTool } from "./constants"

export { PROGRAM_TOOLS, type ProgramTool }

/**
 * PCP's own tools a program may call (#164): a wrapper's tool and a
 * run_<tier> program reach them through pcp.call("pcp", "<tool>", args),
 * and a wrapper lists them in `calls` as "pcp/<tool>". This is the one
 * place that says which: data tools that read or write the owner's files
 * and the web, never an admin or owner tool (register_server, propose_*,
 * the secret tools, memory, update_pcp, the permission tools, delete...).
 * An addition goes here, with its tier, and gets a line in
 * program-tools.test.ts, which also checks the tier against the tool.
 *
 * A token's programs reach one only when the owner ticked it for the token
 * (api_token.builtin_tools: a JSON array of these names), and then through
 * the same validator, tier gate, levels, duplicate guard and request log
 * as execute_<tier>'s dispatch of the tool (gateway.ts ownProgramCall).
 */

/** What a wrapper's `calls` and the duplicate guard call PCP's own tools. */
export const OWN_SERVER_ID = "pcp"
export const OWN_SERVER_SLUG = "pcp"

export const PROGRAM_TOOL_NAMES: readonly string[] = PROGRAM_TOOLS.map(
  (tool) => tool.name,
)

export function programTool(name: string): ProgramTool | null {
  return PROGRAM_TOOLS.find((tool) => tool.name === name) ?? null
}

/** Whether a program may ever call this tool of PCP's. */
export function isProgramTool(name: string): boolean {
  return programTool(name) !== null
}

/**
 * A token's stored choice as a list of eligible names, each once, in the
 * order of PROGRAM_TOOLS: anything that is not one (an edited export, a
 * tool since removed) is dropped.
 */
export function parseBuiltinTools(stored: unknown): string[] {
  let parsed: unknown = stored

  if (typeof stored === "string") {
    try {
      parsed = JSON.parse(stored)
    } catch {
      return []
    }
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const chosen = new Set(parsed.filter((name) => typeof name === "string"))

  return PROGRAM_TOOL_NAMES.filter((name) => chosen.has(name))
}

export function storeBuiltinTools(names: readonly string[]): string {
  return JSON.stringify(parseBuiltinTools(names))
}
