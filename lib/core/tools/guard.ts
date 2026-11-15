import type { Tool } from "./define"

/**
 * Whether the duplicate guard (calls/guard.ts) watches calls of one of PCP's
 * own tools, a property of the tool as it is registered (gateway.ts
 * register's `guard`), never a list kept elsewhere. A tool that declares
 * nothing is guarded when it is Write or Destructive.
 *
 * - `never`: a repeat does nothing twice, or the work is guarded where it
 *   happens (the stores' tools run their own on the store's server; the
 *   capabilities make a new file from one and touch nothing else). The
 *   reason is for the reader of the code.
 * - `reads`: a call is guarded unless this says it only reads, for a tool
 *   whose reading and changing calls differ by their arguments (memory's
 *   command, web_fetch's method).
 *
 * A tool whose annotations say idempotent is not guarded either (it answers
 * a repeat itself), and a Read tool never is.
 */
export type OwnGuard =
  { never: string } | { reads: (args: Record<string, unknown>) => boolean }

const GUARDS = new WeakMap<Tool, OwnGuard>()

export function setOwnGuard(tool: Tool, guard: OwnGuard | undefined): void {
  if (guard) {
    GUARDS.set(tool, guard)
  }
}

export function ownGuardOf(tool: Tool): OwnGuard | undefined {
  return GUARDS.get(tool)
}

/**
 * Whether any call of this tool can be held back as a repeat, at the tier
 * it runs at.
 */
export function ownToolGuarded(tool: Tool, tier: string): boolean {
  const guard = GUARDS.get(tool)

  return (
    tier !== "read" &&
    !(guard && "never" in guard) &&
    tool.annotations.idempotentHint !== true
  )
}

/** Whether this call, by its arguments, only reads and so is not guarded. */
export function ownCallOnlyReads(
  tool: Tool,
  args: Record<string, unknown>,
): boolean {
  const guard = GUARDS.get(tool)

  return guard !== undefined && "reads" in guard && guard.reads(args)
}

export const GUARD_NEVER = {
  /** The stores' tools: their own tool runs on the store's server, guarded there. */
  store: {
    never: "Runs the store's own tool, which the guard watches by its rules.",
  },
  /** The capabilities: a new file from one, nothing else touched. */
  capability: {
    never: "Makes a new file from one and touches nothing else.",
  },
} satisfies Record<string, OwnGuard>

export const GUARD_READS = {
  memory: {
    reads: (args) => ["view", "search", "every"].includes(String(args.command)),
  },
  webFetch: {
    reads: (args) => {
      const method =
        typeof args.method === "string" ? args.method.toUpperCase() : "GET"
      return method === "GET" || method === "HEAD"
    },
  },
} satisfies Record<string, OwnGuard>
