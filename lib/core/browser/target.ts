import type { Locator, Page } from "patchright-core"

import { MAX_TARGET_CANDIDATES } from "./limits"
import {
  missingRefMessage,
  resolveTabRef,
  tabSnapshot,
  type RefHolder,
} from "./refs"
import {
  allNodes,
  describeNode,
  nodeByRef,
  parseSnapshot,
  type ElementMatch,
  type SnapshotNode,
} from "./snapshot"

/**
 * An element named by what it is rather than by a ref: its role and its
 * accessible name, as Playwright's getByRole finds it, optionally inside
 * the element a ref names (within) and the nth of several. So a program
 * (run_code, a wrapper) can act on a page without a snapshot's refs first.
 * It must come out as exactly one element: one that matches none, or more
 * than one without nth, is refused with the elements it could have meant.
 */
export type Target = {
  role: string
  name: string
  exact?: boolean
  nth?: number
  within?: string
}

export type Resolved = { locator: Locator } | { refusal: string }

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Whether a name matches as getByRole matches it. */
export function nameMatches(
  name: string | null,
  wanted: string,
  exact = false,
): boolean {
  if (name === null) {
    return false
  }

  return exact
    ? normalized(name) === normalized(wanted)
    : normalized(name).toLowerCase().includes(normalized(wanted).toLowerCase())
}

function described(target: Target): string {
  return `${target.role} named "${target.name}"${target.within ? ` inside ${target.within}` : ""}`
}

function listed(candidates: ElementMatch[], more: number): string {
  const lines = candidates.map((candidate) => JSON.stringify(candidate))
  return [...lines, ...(more > 0 ? [`… and ${more} more`] : [])].join("\n")
}

/**
 * Why a target is refused, with what it could have meant, from the page's
 * snapshot (`nodes`, the `within` element's when there is one) and how
 * many elements Playwright found.
 */
export function targetRefusal(
  nodes: SnapshotNode[],
  target: Target,
  count: number,
): string | null {
  const ofRole = allNodes(nodes).filter((node) => node.role === target.role)

  if (count === 0) {
    const shown = ofRole
      .slice(0, MAX_TARGET_CANDIDATES)
      .map((node) => describeNode(node))

    return shown.length === 0
      ? `There is no ${described(target)} on the page, and no ${target.role} at all. Take a snapshot to see the page's elements and their roles.`
      : `There is no ${described(target)} on the page. The ${target.role} elements it has (give one's name, or its ref):\n${listed(shown, ofRole.length - shown.length)}`
  }

  if (target.nth !== undefined && target.nth >= count) {
    return `Only ${count} ${count === 1 ? "element matches" : "elements match"} ${described(target)}, so there is no nth ${target.nth} (nth counts from 0).`
  }

  if (target.nth === undefined && count > 1) {
    const matching = ofRole.filter((node) =>
      nameMatches(node.name, target.name, target.exact),
    )
    const shown = matching
      .slice(0, MAX_TARGET_CANDIDATES)
      .map((node) => describeNode(node))

    return `${count} elements match ${described(target)}. Say which: nth (0 for the first, in page order), exact: true for the whole name, within (the ref of the part of the page it is in), or its ref.${shown.length > 0 ? `\n${listed(shown, matching.length - shown.length)}` : ""}`
  }

  return null
}

/**
 * The one element a target names in a tab, or why not. `within` must be an
 * element of the page now, as any ref must. A refusal's snapshot is the
 * tab's (refs.ts), so it takes no ref from an element still there.
 */
export async function resolveTarget(
  tab: RefHolder,
  target: Target,
): Promise<Resolved> {
  const page = tab.page
  let scope: Locator | null = null

  if (target.within) {
    scope = await resolveTabRef(tab, target.within)

    if (!scope) {
      return {
        refusal: `${missingRefMessage(tab, target.within)} (It was the target's within.)`,
      }
    }
  }

  const options = { name: target.name, exact: target.exact ?? false }
  // The role is checked against the ARIA roles' shape, not their list:
  // one Playwright does not know matches nothing, and is refused below.
  const role = target.role as Parameters<Page["getByRole"]>[0]
  const all = (scope ?? page).getByRole(role, options)
  const count = await all.count()

  if (count === 1 && target.nth === undefined) {
    return { locator: all }
  }

  if (count > 0 && target.nth !== undefined && target.nth < count) {
    return { locator: all.nth(target.nth) }
  }

  const tree = parseSnapshot(await tabSnapshot(tab).catch(() => ""))
  const within = target.within ? nodeByRef(tree, target.within) : null

  return {
    refusal:
      targetRefusal(within ? [within] : tree, target, count) ??
      `There is no ${described(target)} on the page.`,
  }
}
