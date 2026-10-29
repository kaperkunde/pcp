import { describe, expect, it } from "vitest"

import { TabRefs } from "./refs"
import { mapRefs, parseSnapshot } from "./snapshot"

// PCP's refs for a tab's elements hold while the element is on the page:
// across snapshots, through a page that draws itself anew (Playwright gives
// a redrawn element a new ref), and back after a dialog covered it.

/** The refs a rewritten snapshot gives each line's element, by its role and name. */
function refsIn(tree: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const line of tree.split("\n")) {
    const match = line.match(/- (\w+ "[^"]*"|\w+) .*\[ref=((?:f\d+)?e\d+)\]/)
    if (match) out[match[1]!] = match[2]!
  }

  return out
}

const PAGE = `- generic [active] [ref=e1]:
  - heading "Inbox" [level=1] [ref=e2]
  - list [ref=e3]:
    - listitem [ref=e4]:
      - button "Delete" [ref=e5]
    - listitem [ref=e6]:
      - button "Delete" [ref=e7]
  - button "Save" [ref=e8]
  - iframe [ref=e9]:
    - button "Inner" [ref=f1e2]`

/** The same page drawn anew: every element Playwright saw is a new one. */
const REDRAWN = PAGE.replace(
  /\[ref=e(\d+)\]/g,
  (_, n) => `[ref=e${Number(n) + 20}]`,
)

describe("a tab's refs", () => {
  it("are PCP's own, and the same in a second snapshot of the same page", () => {
    const refs = new TabRefs()
    const first = refs.adopt(PAGE, "doc1")
    const second = refs.adopt(PAGE, "doc1")

    expect(second).toBe(first)
    expect(refsIn(first)['button "Save"']).toMatch(/^e\d+$/)
    // An element in a frame keeps the frame's mark.
    expect(refsIn(first)['button "Inner"']).toMatch(/^f1e\d+$/)
    expect(refs.playwrightRef(refsIn(first)['button "Save"']!)).toBe("e8")
  })

  it("hold through a page that draws itself anew, where Playwright's change", () => {
    const refs = new TabRefs()
    const before = parseSnapshot(refs.adopt(PAGE, "doc1"))
    const after = parseSnapshot(refs.adopt(REDRAWN, "doc1"))

    const deletes = (nodes: ReturnType<typeof parseSnapshot>) =>
      nodes[0]!.children[1]!.children.map((item) => item.children[0]!.ref)

    expect(deletes(after)).toEqual(deletes(before))
    const save = (nodes: ReturnType<typeof parseSnapshot>) =>
      nodes[0]!.children[2]!.ref!
    expect(save(after)).toBe(save(before))
    expect(refs.playwrightRef(save(after))).toBe("e28")
  })

  it("gives a redrawn list that lost a line new refs, not its neighbour's", () => {
    const refs = new TabRefs()
    const before = refs.adopt(PAGE, "doc1")
    const oldDeletes = [
      ...before.matchAll(/button "Delete" \[ref=(e\d+)\]/g),
    ].map((match) => match[1])
    const shorter = `- generic [active] [ref=e1]:
  - heading "Inbox" [level=1] [ref=e2]
  - list [ref=e3]:
    - listitem [ref=e30]:
      - button "Delete" [ref=e31]
  - button "Save" [ref=e8]`
    const after = refs.adopt(shorter, "doc1")
    const newDelete = after.match(/button "Delete" \[ref=(e\d+)\]/)![1]

    expect(oldDeletes).not.toContain(newDelete)
    expect(refs.gave(oldDeletes[0]!)).toBe(true)
    expect(refs.playwrightRef(oldDeletes[0]!)).toBeNull()
    // What Playwright kept stays as it was.
    expect(refsIn(after)['button "Save"']).toBe(refsIn(before)['button "Save"'])
  })

  it("keeps a line's ref when Playwright kept its element, whatever else changed", () => {
    const refs = new TabRefs()
    const before = refsIn(refs.adopt(PAGE, "doc1"))
    const longer = PAGE.replace(
      '  - button "Save" [ref=e8]',
      '  - button "Undo" [ref=e40]\n  - button "Save" [ref=e8]',
    )
    const after = refsIn(refs.adopt(longer, "doc1"))

    expect(after['button "Save"']).toBe(before['button "Save"'])
    expect(after['button "Undo"']).toMatch(/^e\d+$/)
    expect(Object.values(before)).not.toContain(after['button "Undo"'])
  })

  it("gives an element back its ref once what covered it has gone", () => {
    const refs = new TabRefs()
    const save = refsIn(refs.adopt(PAGE, "doc1"))['button "Save"']!
    // A dialog over the page: Playwright gives what is under it no ref.
    const covered = `- generic [active] [ref=e1]:
  - heading "Inbox" [level=1]
  - button "Save"
  - dialog "Cookie consent" [ref=e50]:
    - button "Accept" [ref=e51]`

    refs.adopt(covered, "doc1")
    expect(refs.playwrightRef(save)).toBeNull()
    expect(refs.gave(save)).toBe(true)

    expect(refsIn(refs.adopt(PAGE, "doc1"))['button "Save"']).toBe(save)
    expect(refs.playwrightRef(save)).toBe("e8")
  })

  it("starts afresh on a new document, never reusing a ref", () => {
    const refs = new TabRefs()
    const first = refsIn(refs.adopt(PAGE, "doc1"))
    const second = refsIn(refs.adopt(PAGE, "doc2"))

    for (const ref of Object.values(second)) {
      expect(Object.values(first)).not.toContain(ref)
    }
    expect(refs.playwrightRef(first['button "Save"']!)).toBeNull()
  })

  it("tells a ref it gave from one it never did", () => {
    const refs = new TabRefs()
    refs.adopt(PAGE, null)

    expect(refs.gave("e1")).toBe(true)
    expect(refs.gave("f1e3")).toBe(true)
    expect(refs.gave("e999")).toBe(false)
    expect(refs.gave("nonsense")).toBe(false)
  })
})

describe("writing a snapshot's refs", () => {
  it("changes only an element's own ref, never a name that reads like one", () => {
    const tree = `- button "[ref=e5]" [ref=e5]
- 'heading "Time: now" [level=2] [ref=e6]'
- paragraph [ref=e7]: see [ref=e7]
- /url: /x`

    expect(mapRefs(tree, (ref) => (ref === "e6" ? null : `x${ref}`))).toBe(
      `- button "[ref=e5]" [ref=xe5]
- 'heading "Time: now" [level=2]'
- paragraph [ref=xe7]: see [ref=e7]
- /url: /x`,
    )
  })
})
