import { createHash } from "node:crypto"

import type { Locator, Page } from "patchright-core"

import {
  ACTION_TIMEOUT_MS,
  MAX_ELEMENT_NAME_CHARS,
  MAX_GONE_REFS,
  MAX_PAGE_REFS,
} from "./limits"
import { bounded } from "./queue"
import {
  allNodes,
  mapRefs,
  parseSnapshot,
  resolvePlaywrightRef,
  snapshotTree,
  type SnapshotNode,
} from "./snapshot"

/**
 * PCP's own refs for a tab's elements, which hold while the element is on
 * the page. Playwright's refs are good only until its next snapshot, and a
 * page that draws itself anew (React and the like put a new element where
 * the old one was) gets new ones every time, so an assistant's ref from one
 * answer was gone by the next. Each tab keeps a map instead: PCP's ref, the
 * element's fingerprint, and Playwright's ref for it in the latest
 * snapshot. Every snapshot of the tab (an answer's, find's, read_page's,
 * a refusal's) goes through it, and its elements are matched to the ones
 * before:
 *
 * 1. by Playwright's ref, which it keeps on an element for as long as the
 *    element is there with the same role and name;
 * 2. else by fingerprint: role, accessible name, the roles and names of
 *    the elements around it in the tree, and which of the elements that
 *    share all of that it is (in page order), taken only while the page
 *    has as many of those as before, so a list that lost or gained a line
 *    gives its redrawn lines new refs rather than a neighbour's;
 * 3. else it is new, and gets a new ref.
 *
 * Refs are numbered per tab and never reused, so a ref whose element has
 * gone is told apart from one the tab never gave without remembering it.
 * A new document in the tab (a page opened, not a page's own change of
 * address) starts the matching afresh. An element in a frame keeps the
 * frame's mark in front (f1e12), as Playwright writes it. The map holds
 * the latest snapshot's elements (at most MAX_PAGE_REFS) and, for an
 * element out of it for now (covered by a dialog, hidden), the last
 * MAX_GONE_REFS of those, so it gets its ref back when it shows again.
 */

type Entry = {
  ref: string
  /** Playwright's ref for it in the snapshot it was last in. */
  playwright: string
  /** Its role and name. */
  identity: string
  /** Its role, name and the elements around it. */
  group: string
  /** Which of its group it is, in page order, and how many there were. */
  ordinal: number
  groupSize: number
  /** The snapshot it was last in. */
  seen: number
}

type Seen = {
  node: SnapshotNode
  playwright: string
  identity: string
  group: string
  ordinal: number
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16)
}

function label(node: SnapshotNode): string {
  return `${node.role}\u0000${(node.name ?? "").slice(0, MAX_ELEMENT_NAME_CHARS)}`
}

function framePrefix(ref: string): string {
  return ref.match(/^f\d+/)?.[0] ?? ""
}

/** The number in a ref (e12, f1e12), or null for none. */
function refNumber(ref: string): number | null {
  const number = ref.match(/e(\d+)$/)?.[1]
  return number === undefined ? null : Number(number)
}

/** One tab's refs. Pure: what it is given is a snapshot's text. */
export class TabRefs {
  private next = 1
  private snapshots = 0
  private document: string | null = null
  /** The latest snapshot's elements, by PCP's ref. */
  private live = new Map<string, Entry>()
  /** Elements out of the latest snapshot for now, oldest first. */
  private gone = new Map<string, Entry>()

  /**
   * A snapshot with Playwright's refs, written with PCP's; the map is the
   * snapshot's from then on. `document` tells one document of the tab
   * from the next (null: not known, taken as the same).
   */
  adopt(tree: string, document: string | null = null): string {
    if (document !== null && this.document !== null) {
      if (document !== this.document) {
        this.live.clear()
        this.gone.clear()
      }
    }

    if (document !== null) {
      this.document = document
    }

    this.snapshots += 1
    const seen = this.read(tree)
    const sizes = new Map<string, number>()

    for (const element of seen) {
      sizes.set(element.group, (sizes.get(element.group) ?? 0) + 1)
    }

    const known = [...this.gone.values(), ...this.live.values()]
    const byPlaywright = new Map(
      known.map((entry) => [entry.playwright, entry]),
    )
    const byPlace = new Map(
      known.map((entry) => [`${entry.group}#${entry.ordinal}`, entry]),
    )
    const taken = new Set<string>()
    const given = new Map<Seen, string>()

    for (const element of seen) {
      const entry = byPlaywright.get(element.playwright)

      if (
        entry &&
        entry.identity === element.identity &&
        !taken.has(entry.ref)
      ) {
        taken.add(entry.ref)
        given.set(element, entry.ref)
      }
    }

    for (const element of seen) {
      if (given.has(element)) continue

      const entry = byPlace.get(`${element.group}#${element.ordinal}`)

      if (
        entry &&
        entry.groupSize === sizes.get(element.group) &&
        !taken.has(entry.ref)
      ) {
        taken.add(entry.ref)
        given.set(element, entry.ref)
      }
    }

    const live = new Map<string, Entry>()
    const byOld = new Map<string, string>()

    for (const element of seen) {
      const ref =
        given.get(element) ??
        `${framePrefix(element.playwright)}e${this.next++}`

      byOld.set(element.playwright, ref)
      live.set(ref, {
        ref,
        playwright: element.playwright,
        identity: element.identity,
        group: element.group,
        ordinal: element.ordinal,
        groupSize: sizes.get(element.group)!,
        seen: this.snapshots,
      })
    }

    for (const entry of this.live.values()) {
      if (!live.has(entry.ref)) this.gone.set(entry.ref, entry)
    }

    for (const ref of live.keys()) this.gone.delete(ref)

    for (const ref of this.gone.keys()) {
      if (this.gone.size <= MAX_GONE_REFS) break
      this.gone.delete(ref)
    }

    this.live = live

    return mapRefs(tree, (ref) => byOld.get(ref) ?? null)
  }

  /** The snapshot's elements that have a ref, in page order, at most MAX_PAGE_REFS. */
  private read(tree: string): Seen[] {
    const elements = allNodes(parseSnapshot(tree)).filter(
      (node): node is SnapshotNode & { ref: string } => node.ref !== null,
    )
    const counts = new Map<string, number>()

    return elements.slice(0, MAX_PAGE_REFS).map((node) => {
      const around: string[] = []

      for (let up = node.parent; up; up = up.parent) around.push(label(up))

      const identity = digest(label(node))
      const group = digest(`${label(node)}\u0001${around.join("\u0001")}`)
      const ordinal = counts.get(group) ?? 0
      counts.set(group, ordinal + 1)

      return { node, playwright: node.ref, identity, group, ordinal }
    })
  }

  /** Playwright's ref for one of PCP's in the latest snapshot; null for none. */
  playwrightRef(ref: string): string | null {
    return this.live.get(ref)?.playwright ?? null
  }

  /** Whether the tab gave the ref (whether or not its element is there now). */
  gave(ref: string): boolean {
    const number = refNumber(ref)
    return number !== null && number >= 1 && number < this.next
  }
}

/** What a tab's refs belong to: the tab itself, which outlives its page. */
export type RefHolder = { page: Page }

const MAPS = new WeakMap<RefHolder, TabRefs>()

export function refsOf(holder: RefHolder): TabRefs {
  let refs = MAPS.get(holder)

  if (!refs) {
    refs = new TabRefs()
    MAPS.set(holder, refs)
  }

  return refs
}

/**
 * Which document the page shows: its time origin, which each new document
 * has of its own, and a page's change of address (history.pushState) does
 * not change. Read in PCP's own world, not the page's.
 */
async function documentKey(page: Page): Promise<string | null> {
  try {
    const origin = await bounded(
      page.evaluate(() => performance.timeOrigin, undefined, undefined, true),
      ACTION_TIMEOUT_MS,
      "performance.timeOrigin",
    )
    return typeof origin === "number" ? String(origin) : null
  } catch {
    return null
  }
}

/**
 * The tab's snapshot (snapshot.ts, with its fields masked) written with
 * PCP's refs, its map updated: every snapshot an answer shows or searches
 * is taken through here, so none takes a ref from an element still there.
 */
export async function tabSnapshot(holder: RefHolder): Promise<string> {
  const tree = await snapshotTree(holder.page)
  return refsOf(holder).adopt(tree, await documentKey(holder.page))
}

/**
 * The element one of PCP's refs names now: through Playwright's ref for it
 * in the latest snapshot, or, when the page has changed since, a new
 * snapshot's. Null when the element is not on the page now, or not where
 * it can be acted on (Playwright gives a hidden or covered element no ref);
 * `refStatus` tells that from a ref the tab never gave.
 */
export async function resolveTabRef(
  holder: RefHolder,
  ref: string,
): Promise<Locator | null> {
  const refs = refsOf(holder)
  const now = async () => {
    const playwright = refs.playwrightRef(ref)
    return playwright ? resolvePlaywrightRef(holder.page, playwright) : null
  }

  const found = await now()

  if (found || !refs.gave(ref)) {
    return found
  }

  try {
    await tabSnapshot(holder)
  } catch {
    return null
  }

  return now()
}

/** Whether a ref the page does not have now was one of the tab's. */
export function refStatus(holder: RefHolder, ref: string): "gone" | "unknown" {
  return refsOf(holder).gave(ref) ? "gone" : "unknown"
}

/** What an assistant is told of a ref that names nothing on the page now. */
export function missingRefMessage(holder: RefHolder, ref: string): string {
  return refStatus(holder, ref) === "gone"
    ? `The element ${ref} is no longer on the page, or no longer where it can be acted on (hidden, or covered by something like a dialog). A new snapshot shows what the page has now, with its refs.`
    : `There is no element ${ref} on this tab's page: refs come from this tab's snapshots (and find). Take a snapshot to see the page's elements and their refs.`
}
