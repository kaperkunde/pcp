/**
 * How many nodes a value has, with every alias visited as often as it
 * appears; past the limit it stops and answers limit + 1. A cycle never
 * ends, so it stops there too.
 */
export function countNodes(value: unknown, limit: number): number {
  const stack: unknown[] = [value]
  let seen = 0

  while (stack.length > 0) {
    const current = stack.pop()
    seen += 1

    if (seen > limit) {
      return seen
    }

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
    } else if (typeof current === "object" && current !== null) {
      for (const item of Object.values(current)) stack.push(item)
    }
  }

  return seen
}
