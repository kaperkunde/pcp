import { MAX_OUTPUT_SCHEMA_NODES } from "./limits"

/**
 * What a wrapper tool's outputSchema may hold when it is saved: no
 * reference, since a schema checks only what it says itself. Values are
 * checked against it by the one validator (lib/core/tools/validate.ts), on
 * every return (wrappers/run.ts).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Whether a schema has a $ref anywhere in it, or is too big to look through. */
export function hasReference(schema: unknown): boolean {
  const stack: unknown[] = [schema]
  let nodes = 0

  while (stack.length > 0) {
    const node = stack.pop()

    if (++nodes > MAX_OUTPUT_SCHEMA_NODES) {
      return true
    }

    if (Array.isArray(node)) {
      stack.push(...node)
    } else if (isRecord(node)) {
      if ("$ref" in node || "$dynamicRef" in node) {
        return true
      }

      stack.push(...Object.values(node))
    }
  }

  return false
}
