/**
 * A three-way merge of texts, line by line, as diff3 does it: what changed
 * from the base on one side only is taken from that side, what both sides
 * changed the same way is taken once, and what they changed differently is
 * a conflict, written between markers for a person to settle. Pure: no
 * database, no I/O.
 */

export const CONFLICT_START = "<<<<<<< Yours"
export const CONFLICT_MIDDLE = "======="
export const CONFLICT_END = ">>>>>>> PCP's suggestion"

export type LineMerge = {
  text: string
  /** How many places are marked for a person to settle. */
  conflicts: number
}

/** The most lines a side may have; past it, the whole text is one conflict. */
const MAX_LINES = 2_000

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n")
}

/**
 * The pairs of indices of a longest common subsequence of two lists of
 * lines, in order.
 */
function commonLines(a: string[], b: string[]): Array<[number, number]> {
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      i++
    } else {
      j++
    }
  }

  return pairs
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

function conflict(mine: string[], theirs: string[]): string[] {
  return [CONFLICT_START, ...mine, CONFLICT_MIDDLE, ...theirs, CONFLICT_END]
}

/** Merges `mine` and `theirs`, both changed from `base`. */
export function mergeLines(
  base: string,
  mine: string,
  theirs: string,
): LineMerge {
  const original = lines(base)
  const ours = lines(mine)
  const other = lines(theirs)

  if (same(ours, other) || same(other, original)) {
    return { text: ours.join("\n"), conflicts: 0 }
  }

  if (same(ours, original)) {
    return { text: other.join("\n"), conflicts: 0 }
  }

  if (
    original.length > MAX_LINES ||
    ours.length > MAX_LINES ||
    other.length > MAX_LINES
  ) {
    return { text: conflict(ours, other).join("\n"), conflicts: 1 }
  }

  const toMine = new Map(commonLines(original, ours))
  const toTheirs = new Map(commonLines(original, other))
  // Lines of the base both sides kept: the merge is settled around them.
  const anchors: Array<[number, number, number]> = []

  for (let index = 0; index < original.length; index++) {
    const m = toMine.get(index)
    const t = toTheirs.get(index)

    if (m !== undefined && t !== undefined) {
      anchors.push([index, m, t])
    }
  }

  anchors.push([original.length, ours.length, other.length])

  const out: string[] = []
  let conflicts = 0
  let at: [number, number, number] = [0, 0, 0]

  for (const anchor of anchors) {
    const was = original.slice(at[0], anchor[0])
    const left = ours.slice(at[1], anchor[1])
    const right = other.slice(at[2], anchor[2])

    if (same(left, right) || same(right, was)) {
      out.push(...left)
    } else if (same(left, was)) {
      out.push(...right)
    } else {
      out.push(...conflict(left, right))
      conflicts++
    }

    if (anchor[0] < original.length) {
      out.push(original[anchor[0]]!)
    }

    at = [anchor[0] + 1, anchor[1] + 1, anchor[2] + 1]
  }

  return { text: out.join("\n"), conflicts }
}

/** Whether a text still has a marker of a conflict in it. */
export function hasConflictMarkers(text: string): boolean {
  return lines(text).some(
    (line) =>
      line.startsWith("<<<<<<< ") ||
      line.startsWith(">>>>>>> ") ||
      line === CONFLICT_MIDDLE,
  )
}
