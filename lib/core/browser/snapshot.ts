import type { Locator, Page } from "patchright-core"

import {
  ACTION_TIMEOUT_MS,
  MAX_ELEMENT_NAME_CHARS,
  MAX_FIND_MATCHES,
} from "./limits"

/**
 * The page as an assistant reads it: Playwright's accessibility snapshot
 * made for AI use, every element it can act on marked with a ref
 * ("[ref=e12]"), and the locator a ref stands for. The only file that
 * names Playwright's snapshot API, or reads its format, so a change to it
 * is a change here. A ref is good until the next snapshot of the page.
 */

/** e12, or f1e12 for an element after the page was replaced or in a frame. */
export const REF_PATTERN = /^(f\d{1,4})?e\d{1,7}$/

export function snapshotTree(page: Page): Promise<string> {
  return page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS })
}

export function byRef(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${ref}`)
}

/** The element a ref stands for, or null when the page no longer has it. */
export async function resolveRef(
  page: Page,
  ref: string,
): Promise<Locator | null> {
  const locator = byRef(page, ref)
  const found = await locator.count().catch(() => 0)
  return found > 0 ? locator : null
}

/** What an element's state says, where the snapshot gives it. */
export type ElementStates = {
  disabled?: true
  checked?: true | "mixed"
  expanded?: boolean
  selected?: true
  active?: true
  level?: number
}

/** One line of a snapshot: an element, or text inside one. */
export type SnapshotNode = {
  role: string
  name: string | null
  ref: string | null
  states: ElementStates
  /** Text written after the element on its own line ("listitem: Hi"). */
  text: string | null
  /** A link's address ("/url:" under it). */
  url: string | null
  parent: SnapshotNode | null
  children: SnapshotNode[]
}

/**
 * The roles that mark a part of a page: what tells two lines that read the
 * same apart (a preview in the sidebar, a line of the thread).
 */
const LANDMARKS = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
  "dialog",
  "alertdialog",
])

/** A YAML scalar as the snapshot writes one: quoted, or as it is. */
function scalar(raw: string): string {
  const value = raw.trim()

  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, value.endsWith('"') ? -1 : undefined)
    }
  }

  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
    return value.slice(1, -1).replace(/''/g, "'")
  }

  return value
}

/**
 * Splits "key: value" where the key may be single-quoted (the snapshot
 * quotes a key that holds a colon) and the name inside it double-quoted.
 */
function splitEntry(entry: string): { key: string; value: string | null } {
  if (entry.startsWith("'")) {
    let at = 1

    while (at < entry.length) {
      if (entry[at] === "'") {
        if (entry[at + 1] === "'") {
          at += 2
          continue
        }

        break
      }

      at += 1
    }

    const key = entry.slice(1, at).replace(/''/g, "'")
    const rest = entry.slice(at + 1).trimStart()
    return {
      key,
      value: rest.startsWith(":") ? rest.slice(1).trim() || null : null,
    }
  }

  // Outside a quoted name, the first ": " (or a closing ":") ends the key.
  let quoted = false

  for (let at = 0; at < entry.length; at += 1) {
    const char = entry[at]

    if (char === "\\" && quoted) {
      at += 1
      continue
    }

    if (char === '"') {
      quoted = !quoted
      continue
    }

    if (
      !quoted &&
      char === ":" &&
      (at === entry.length - 1 || entry[at + 1] === " ")
    ) {
      return {
        key: entry.slice(0, at),
        value: entry.slice(at + 1).trim() || null,
      }
    }
  }

  return { key: entry, value: null }
}

/** role "name" [attr] [attr=value] */
function parseKey(
  key: string,
): Pick<SnapshotNode, "role" | "name" | "ref" | "states"> | null {
  const role = key.match(/^[a-zA-Z][\w-]*/)?.[0]

  if (!role) {
    return null
  }

  let rest = key.slice(role.length).trimStart()
  let name: string | null = null

  if (rest.startsWith('"')) {
    let at = 1

    while (at < rest.length && rest[at] !== '"') {
      at += rest[at] === "\\" ? 2 : 1
    }

    name = scalar(rest.slice(0, at + 1))
    rest = rest.slice(at + 1)
  } else if (rest.startsWith("/")) {
    // A name written as a pattern (not in the AI mode, but read as words).
    const end = rest.indexOf("/", 1)
    name = rest.slice(1, end > 0 ? end : undefined)
    rest = end > 0 ? rest.slice(end + 1) : ""
  }

  let ref: string | null = null
  const states: ElementStates = {}

  for (const [, attr, value] of rest.matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)) {
    switch (attr) {
      case "ref":
        ref = value ?? null
        break
      case "disabled":
        states.disabled = true
        break
      case "checked":
        states.checked = value === "mixed" ? "mixed" : true
        break
      case "expanded":
        states.expanded = value !== "false"
        break
      case "selected":
        states.selected = true
        break
      case "active":
        states.active = true
        break
      case "level": {
        const level = Number(value)
        if (Number.isInteger(level)) states.level = level
        break
      }
    }
  }

  return { role, name, ref, states }
}

/**
 * The snapshot as a tree. Lines it does not recognise are skipped, so a
 * change in Playwright's format loses detail rather than failing.
 */
export function parseSnapshot(tree: string): SnapshotNode[] {
  const roots: SnapshotNode[] = []
  const stack: Array<{ indent: number; node: SnapshotNode }> = []

  for (const line of tree.split("\n")) {
    const match = line.match(/^(\s*)- (.*)$/)

    if (!match) {
      continue
    }

    const indent = match[1]!.length
    const entry = match[2]!.trim()

    while (stack.length > 0 && stack.at(-1)!.indent >= indent) {
      stack.pop()
    }

    const parent = stack.at(-1)?.node ?? null
    const { key, value } = splitEntry(entry)

    if (key.startsWith("/")) {
      // A property of the element above: a link's address, a placeholder.
      if (parent && key === "/url" && value !== null) {
        parent.url = scalar(value)
      }

      continue
    }

    const parsed =
      key === "text"
        ? { role: "text", name: null, ref: null, states: {} }
        : parseKey(key)

    if (!parsed) {
      continue
    }

    const node: SnapshotNode = {
      ...parsed,
      text: value === null ? null : scalar(value),
      url: null,
      parent,
      children: [],
    }

    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }

    stack.push({ indent, node })
  }

  return roots
}

function* walk(nodes: SnapshotNode[]): Generator<SnapshotNode> {
  for (const node of nodes) {
    yield node
    yield* walk(node.children)
  }
}

/** Every element in the trees, in the order the page has them. */
export function allNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  return [...walk(nodes)]
}

/** The element a ref names in a snapshot, or null. */
export function nodeByRef(
  nodes: SnapshotNode[],
  ref: string,
): SnapshotNode | null {
  for (const node of walk(nodes)) {
    if (node.ref === ref) return node
  }

  return null
}

/** The nearest part of the page (a landmark, a region, a dialog) it is in. */
export function landmarkOf(
  node: SnapshotNode,
): { role: string; name?: string; ref?: string } | null {
  for (let up = node.parent; up; up = up.parent) {
    if (LANDMARKS.has(up.role)) {
      return {
        role: up.role,
        ...(up.name ? { name: clip(up.name) } : {}),
        ...(up.ref ? { ref: up.ref } : {}),
      }
    }
  }

  return null
}

function clip(value: string): string {
  return value.length > MAX_ELEMENT_NAME_CHARS
    ? `${value.slice(0, MAX_ELEMENT_NAME_CHARS)}…`
    : value
}

/** An element as find, or a refusal, describes it. */
export type ElementMatch = {
  role: string
  name?: string
  ref?: string
  text?: string
  url?: string
  states?: ElementStates
  landmark?: { role: string; name?: string; ref?: string }
}

export function describeNode(
  node: SnapshotNode,
  { text }: { text?: string | null } = {},
): ElementMatch {
  const landmark = landmarkOf(node)
  const shown = text ?? node.text

  return {
    role: node.role,
    ...(node.name ? { name: clip(node.name) } : {}),
    ...(node.ref ? { ref: node.ref } : {}),
    ...(shown ? { text: clip(shown) } : {}),
    ...(node.url ? { url: clip(node.url) } : {}),
    ...(Object.keys(node.states).length > 0 ? { states: node.states } : {}),
    ...(landmark ? { landmark } : {}),
  }
}

/**
 * The elements of a snapshot whose name, text or address mentions the
 * text (case aside), in page order, at most MAX_FIND_MATCHES. Text on a
 * line of its own counts for the element it is in. `within` is the tree
 * to search (an element and what is inside it).
 */
export function findInSnapshot(
  nodes: SnapshotNode[],
  text: string,
): { matches: ElementMatch[]; total: number } {
  const needle = text.toLowerCase()
  const has = (value: string | null) =>
    value !== null && value.toLowerCase().includes(needle)
  const seen = new Set<SnapshotNode>()
  const matches: ElementMatch[] = []
  let total = 0

  for (const node of walk(nodes)) {
    let element: SnapshotNode | null = node
    let shown: string | null = null

    if (node.role === "text") {
      if (!has(node.text)) continue
      element = node.parent
      shown = node.text
    } else if (!has(node.name) && !has(node.text) && !has(node.url)) {
      continue
    }

    if (!element || seen.has(element)) {
      continue
    }

    seen.add(element)
    total += 1

    if (matches.length < MAX_FIND_MATCHES) {
      matches.push(describeNode(element, { text: shown }))
    }
  }

  return { matches, total }
}
