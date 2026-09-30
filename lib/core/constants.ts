/**
 * Values shared with client components. Nothing here may import anything:
 * a client bundle that reaches lib/core proper would drag Prisma in.
 */

export const MIN_PASSWORD_LENGTH = 10

export const DEFAULT_HEADER_NAME = "Authorization"
export const DEFAULT_VALUE_TEMPLATE = "Bearer {{secret}}"
export const SECRET_PLACEHOLDER = "{{secret}}"

/**
 * What one API token may do with one tool. `ask` is the default: the owner
 * is asked the first time, and decides then for the calls after it.
 */
export const TOOL_ACCESS_LEVELS = ["allowed", "ask", "blocked"] as const

export type ToolAccess = (typeof TOOL_ACCESS_LEVELS)[number]

export const DEFAULT_TOOL_ACCESS: ToolAccess = "ask"

export const TOOL_ACCESS_LABELS: Record<ToolAccess, string> = {
  allowed: "Allowed",
  ask: "Ask you first",
  blocked: "Blocked",
}

/** How the owner can answer an assistant's request. */
export const PERMISSION_DECISIONS = [
  "allow_once",
  "always",
  "block",
  "decline",
] as const

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

export type PermissionKind = "call" | "register"
