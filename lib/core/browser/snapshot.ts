import type { Locator, Page } from "patchright-core"

import { heldValues } from "./held"
import {
  ACTION_TIMEOUT_MS,
  MAX_ELEMENT_NAME_CHARS,
  MAX_FIND_MATCHES,
  MAX_MASKED_FRAMES,
} from "./limits"
import { bounded } from "./queue"

/**
 * The page as an assistant reads it: Playwright's accessibility snapshot
 * made for AI use, every element it can act on marked with a ref
 * ("[ref=e12]"), and the locator a ref stands for. The only file that
 * names Playwright's snapshot API, or reads its format, so a change to it
 * is a change here. The refs Playwright writes are its own, and good only
 * until its next snapshot of the page; refs.ts turns them into PCP's, which
 * hold while their element is on the page.
 */

/** e12, or f1e12 for an element after the page was replaced or in a frame. */
export const REF_PATTERN = /^(f\d{1,4})?e\d{1,7}$/

/**
 * The page's snapshot, with what its fields must not show masked
 * (`fieldMasks`): a field holding a secret PCP typed reads as
 * [secret: name], and a password field as [password]. Playwright's
 * snapshot writes every field's value as it is, a password's too.
 */
export async function snapshotTree(page: Page): Promise<string> {
  const tree = await page.ariaSnapshot({
    mode: "ai",
    timeout: ACTION_TIMEOUT_MS,
  })

  return maskFields(tree, await fieldMasks(page))
}

/** What stands for a password field's value in a snapshot. */
export const PASSWORD_MASK = "[password]"

export function secretMask(name: string): string {
  return `[secret: ${name}]`
}

/**
 * The values the page's fields must not show, each with what is shown
 * instead: those of fields holding a secret PCP typed (held.ts), then the
 * page's password fields', in every frame. Read for the answer being made
 * and forgotten with it.
 */
export async function fieldMasks(page: Page): Promise<Map<string, string>> {
  const masks = new Map<string, string>()

  for (const { name, value } of (await heldValues(page)).values) {
    masks.set(value, secretMask(name))
  }

  for (const frame of page.frames().slice(0, MAX_MASKED_FRAMES)) {
    const values = await bounded(
      frame
        .locator("input[type=password i]")
        .evaluateAll((fields) =>
          fields.map((field) => (field as HTMLInputElement).value),
        ),
      ACTION_TIMEOUT_MS,
      "password fields",
    ).catch(() => [] as string[])

    for (const value of values) {
      if (value && !masks.has(value)) {
        masks.set(value, PASSWORD_MASK)
      }
    }
  }

  return masks
}

/** The roles a field that holds a value has in a snapshot. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"])

/**
 * The snapshot with each field whose value is one of `masks`' showing its
 * mask instead (`- textbox "Password" [ref=e3]: [password]`). Only a
 * field's own value is touched: the same text elsewhere on the page stays.
 */
export function maskFields(
  tree: string,
  masks: ReadonlyMap<string, string>,
): string {
  if (masks.size === 0) {
    return tree
  }

  return tree
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*)- (.*)$/)

      if (!match) {
        return line
      }

      const entry = match[2]!.trimEnd()
      const { key, value } = splitEntry(entry.trim())
      const role = key.match(/^[a-zA-Z][\w-]*/)?.[0]

      if (value === null || !role || !FIELD_ROLES.has(role)) {
        return line
      }

      const mask = masks.get(scalar(value))

      return mask && entry.endsWith(value)
        ? `${match[1]}- ${entry.slice(0, entry.length - value.length)}${mask}`
        : line
    })
    .join("\n")
}

/** The element one of Playwright's refs stands for in its latest snapshot. */
export function byRef(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${ref}`)
}

/**
 * The element one of Playwright's refs stands for, or null when its latest
 * snapshot does not have it or the page no longer does. refs.ts is what
 * calls this: an assistant's refs are PCP's.
 */
export async function resolvePlaywrightRef(
  page: Page,
  ref: string,
): Promise<Locator | null> {
  const locator = byRef(page, ref)
  const found = await locator.count().catch(() => 0)
  return found > 0 ? locator : null
}

/**
 * The snapshot with each element's ref passed through `map`: the ref it
 * returns instead, or null to leave the element without one. Only the ref
 * in an element's own key is touched, never a name or a text that reads
 * like one.
 */
export function mapRefs(
  tree: string,
  map: (ref: string) => string | null,
): string {
  return tree
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*)- (.*)$/)

      if (!match) {
        return line
      }

      const entry = match[2]!
      const { key, value } = splitEntry(entry.trim())
      const ref = key.startsWith("/") ? null : parseKey(key)?.ref

      if (!ref) {
        return line
      }

      const end =
        value !== null && entry.trimEnd().endsWith(value)
          ? entry.trimEnd().length - value.length
          : entry.length
      const tag = `[ref=${ref}]`
      const at = entry.slice(0, end).lastIndexOf(tag)

      if (at < 0) {
        return line
      }

      const replaced = map(ref)
      const before = entry.slice(0, at)
      const after = entry.slice(at + tag.length)

      return replaced === null
        ? `${match[1]}- ${before.replace(/ $/, "")}${after}`
        : `${match[1]}- ${before}[ref=${replaced}]${after}`
    })
    .join("\n")
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

/** Roles whose name is a label for what they hold, not words of the page. */
const LABELLED_ROLES = new Set([
  ...FIELD_ROLES,
  "checkbox",
  "radio",
  "switch",
  "slider",
])

/** Roles whose name is all they say: written once, and not looked into. */
const NAMED_ROLES = new Set(["link", "button", "img", "image", "option", "tab"])

/**
 * The words of a snapshot (or of a part of it) as lines, for read_page
 * when a page's HTML holds next to none: one its scripts draw, in shadow
 * DOM or in frames, which the accessibility tree reads through. Headings
 * as Markdown's, links with their address, list items as items; no refs,
 * and no field's value or label.
 */
export function snapshotText(nodes: SnapshotNode[]): string {
  const lines: string[] = []
  const push = (raw: string | null, prefix = "") => {
    const line = (raw ?? "").replace(/\s+/g, " ").trim()

    if (line && lines.at(-1) !== `${prefix}${line}`) {
      lines.push(`${prefix}${line}`)
    }
  }
  const emit = (node: SnapshotNode) => {
    if (node.role === "text") {
      push(node.text)
      return
    }

    if (LABELLED_ROLES.has(node.role)) {
      return
    }

    if (node.role === "heading") {
      const level = Math.min(Math.max(node.states.level ?? 2, 1), 6)
      push(node.name ?? node.text, `${"#".repeat(level)} `)
      if (node.name) return
    } else if (NAMED_ROLES.has(node.role) && node.name) {
      push(
        node.role === "link" && node.url
          ? `[${node.name}](${node.url})`
          : node.name,
      )
      return
    } else {
      push(node.text, node.role === "listitem" ? "- " : "")
    }

    for (const child of node.children) emit(child)
  }

  for (const node of nodes) emit(node)

  return lines.join("\n")
}
