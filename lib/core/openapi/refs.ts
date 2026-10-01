import { entries, isObject, own, type JsonObject } from "./json"
import { REF_MAX_DEPTH, REF_MAX_NODES } from "./limits"

/**
 * Local $ref resolution. Only references into the same document ("#/…")
 * are followed: PCP never fetches a remote or relative reference, because
 * that would let a schema make the server request any address it names.
 *
 * Inlining is bounded per operation — by nesting depth and by the number of
 * nodes visited — so a schema whose references fan out exponentially is
 * cut off instead of expanding. A reference back into itself (a tree of
 * comments, say) becomes a placeholder rather than an error.
 */

export type UnsupportedReason =
  "external" | "missing" | "too_deep" | "too_large"

export class UnsupportedRef extends Error {
  constructor(
    readonly ref: string,
    readonly reason: UnsupportedReason,
  ) {
    super(`Unsupported reference ${ref}: ${reason}`)
    this.name = "UnsupportedRef"
  }

  describe(): string {
    switch (this.reason) {
      case "external":
        return `refers to another document (${this.ref.slice(0, 80)})`
      case "missing":
        return `refers to something the schema does not define (${this.ref.slice(0, 80)})`
      case "too_deep":
        return "its schema is nested too deeply"
      case "too_large":
        return "its schema expands to more than PCP reads"
    }
  }
}

export type RefBudget = { nodes: number }

export function newBudget(): RefBudget {
  return { nodes: REF_MAX_NODES }
}

export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) {
    throw new UnsupportedRef(ref, "external")
  }

  if (ref === "#" || ref === "#/") {
    return doc
  }

  if (!ref.startsWith("#/")) {
    throw new UnsupportedRef(ref, "missing")
  }

  let current: unknown = doc

  for (const raw of ref.slice(2).split("/")) {
    let segment: string

    try {
      segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~")
    } catch {
      throw new UnsupportedRef(ref, "missing")
    }

    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)]
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment]
    } else {
      throw new UnsupportedRef(ref, "missing")
    }

    if (current === undefined) {
      throw new UnsupportedRef(ref, "missing")
    }
  }

  return current
}

/**
 * Follows $ref at the top of a node only (a parameter, a request body, a
 * path item), for objects PCP reads field by field.
 */
export function derefShallow(doc: unknown, node: unknown): unknown {
  let current = node
  const seen = new Set<string>()

  for (;;) {
    const ref = own(current, "$ref")

    if (typeof ref !== "string") {
      return current
    }

    if (seen.has(ref) || seen.size > 16) {
      throw new UnsupportedRef(ref, "too_deep")
    }

    seen.add(ref)
    current = resolvePointer(doc, ref)
  }
}

function lastSegment(ref: string): string {
  return ref.split("/").pop()?.replace(/~1/g, "/").replace(/~0/g, "~") || ref
}

/**
 * A deep copy of `node` with every local reference replaced by what it
 * points at. Sibling keys next to a $ref are laid over the target (the
 * OpenAPI 3.1 reading; 3.0 documents rarely have any).
 */
export function inlineRefs(
  doc: unknown,
  node: unknown,
  budget: RefBudget = newBudget(),
): unknown {
  function walk(value: unknown, depth: number, stack: string[]): unknown {
    budget.nodes -= 1

    if (budget.nodes < 0) {
      throw new UnsupportedRef(stack.at(-1) ?? "#", "too_large")
    }

    if (depth > REF_MAX_DEPTH) {
      throw new UnsupportedRef(stack.at(-1) ?? "#", "too_deep")
    }

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1, stack))
    }

    if (!isObject(value)) {
      return value
    }

    const ref = own(value, "$ref")

    if (typeof ref === "string") {
      if (stack.includes(ref)) {
        return { description: `Recursive reference to ${lastSegment(ref)}.` }
      }

      const target = walk(resolvePointer(doc, ref), depth + 1, [...stack, ref])
      const siblings = entries(value).filter(([key]) => key !== "$ref")

      if (siblings.length === 0 || !isObject(target)) {
        return target
      }

      const merged: JsonObject = { ...target }
      for (const [key, sibling] of siblings) {
        merged[key] = walk(sibling, depth + 1, stack)
      }
      return merged
    }

    const copy: JsonObject = {}
    for (const [key, child] of entries(value)) {
      copy[key] = walk(child, depth + 1, stack)
    }
    return copy
  }

  return walk(node, 0, [])
}
