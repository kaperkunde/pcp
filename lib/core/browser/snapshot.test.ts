import { describe, expect, it } from "vitest"

import { MAX_FIND_MATCHES } from "./limits"
import {
  allNodes,
  findInSnapshot,
  landmarkOf,
  maskFields,
  nodeByRef,
  parseSnapshot,
  PASSWORD_MASK,
  secretMask,
  snapshotText,
} from "./snapshot"

// Playwright's AI snapshot read into elements: what find answers with, and
// what a target's refusal lists. The sample is what Chromium gave for a
// page with landmarks, states, a frame and lines that read the same.

const SAMPLE = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - navigation "Main" [ref=e3]:
      - link "Home" [ref=e4] [cursor=pointer]:
        - /url: /a
  - main [ref=e5]:
    - heading "Who \\"are\\" you?" [level=1] [ref=e6]
    - generic [ref=e7]:
      - text: Name
      - textbox "Name" [disabled] [ref=e8]
    - checkbox "Agree" [checked] [ref=e9]
    - checkbox "Some" [checked=mixed] [ref=e22]
    - button "Menu" [expanded] [ref=e10]
    - combobox "Pet" [ref=e11]:
      - option "Dog"
      - option "Cat" [selected]
    - region "Thread" [ref=e12]:
      - list [ref=e13]:
        - listitem [ref=e14]: "Hi there: yes"
        - listitem [ref=e15]:
          - link "Hi there" [ref=e16] [cursor=pointer]:
            - /url: /x
    - tab "Tab 1" [selected] [ref=e17]
    - 'heading "Time: now" [level=2] [ref=e23]'
    - iframe [ref=e18]:
      - button "Inner" [ref=f1e2]
  - complementary "Side" [ref=e19]:
    - paragraph [ref=e20]: Hi there
  - contentinfo [ref=e21]: f`

describe("reading a snapshot", () => {
  const nodes = parseSnapshot(SAMPLE)

  it("gives each element its role, name, ref and states", () => {
    expect(nodeByRef(nodes, "e6")).toMatchObject({
      role: "heading",
      name: 'Who "are" you?',
      states: { level: 1 },
    })
    expect(nodeByRef(nodes, "e8")).toMatchObject({
      role: "textbox",
      name: "Name",
      states: { disabled: true },
    })
    expect(nodeByRef(nodes, "e9")?.states).toEqual({ checked: true })
    expect(nodeByRef(nodes, "e22")?.states).toEqual({ checked: "mixed" })
    expect(nodeByRef(nodes, "e10")?.states).toEqual({ expanded: true })
    expect(nodeByRef(nodes, "e17")?.states).toEqual({ selected: true })
    expect(nodeByRef(nodes, "e1")?.states).toEqual({ active: true })
    expect(nodeByRef(nodes, "e23")).toMatchObject({
      role: "heading",
      name: "Time: now",
      states: { level: 2 },
    })
    expect(nodeByRef(nodes, "e14")?.text).toBe("Hi there: yes")
    expect(nodeByRef(nodes, "e16")?.url).toBe("/x")
    expect(nodeByRef(nodes, "f1e2")?.parent?.ref).toBe("e18")
    // Options carry no ref but are elements all the same.
    expect(
      allNodes(nodes)
        .filter((node) => node.role === "option")
        .map((node) => [node.name, node.states]),
    ).toEqual([
      ["Dog", {}],
      ["Cat", { selected: true }],
    ])
  })

  it("knows the part of the page each element is in", () => {
    expect(landmarkOf(nodeByRef(nodes, "e16")!)).toEqual({
      role: "region",
      name: "Thread",
      ref: "e12",
    })
    expect(landmarkOf(nodeByRef(nodes, "e20")!)).toEqual({
      role: "complementary",
      name: "Side",
      ref: "e19",
    })
    expect(landmarkOf(nodeByRef(nodes, "e4")!)).toMatchObject({
      role: "navigation",
      name: "Main",
    })
    expect(landmarkOf(nodeByRef(nodes, "e2")!)).toBeNull()
  })

  it("skips what it does not recognise rather than failing", () => {
    expect(parseSnapshot("not a snapshot\n  - \n- 123 [ref=e1]")).toEqual([])
  })
})

describe("find", () => {
  const nodes = parseSnapshot(SAMPLE)

  it("answers elements, with the part of the page that tells the same words apart", () => {
    const { matches, total } = findInSnapshot(nodes, "hi there")

    expect(total).toBe(3)
    expect(matches).toEqual([
      {
        role: "listitem",
        ref: "e14",
        text: "Hi there: yes",
        landmark: { role: "region", name: "Thread", ref: "e12" },
      },
      {
        role: "link",
        name: "Hi there",
        ref: "e16",
        url: "/x",
        landmark: { role: "region", name: "Thread", ref: "e12" },
      },
      {
        role: "paragraph",
        ref: "e20",
        text: "Hi there",
        landmark: { role: "complementary", name: "Side", ref: "e19" },
      },
    ])
  })

  it("counts text on a line of its own for the element it is in, and finds by state-free name", () => {
    expect(findInSnapshot(nodes, "name").matches).toEqual([
      {
        role: "generic",
        ref: "e7",
        text: "Name",
        landmark: { role: "main", ref: "e5" },
      },
      {
        role: "textbox",
        name: "Name",
        ref: "e8",
        states: { disabled: true },
        landmark: { role: "main", ref: "e5" },
      },
    ])
  })

  it("searches one part of the page with within", () => {
    const side = nodeByRef(nodes, "e19")!
    expect(
      findInSnapshot([side], "hi there").matches.map((match) => match.ref),
    ).toEqual(["e20"])
  })

  it("answers at most MAX_FIND_MATCHES, and says how many there were", () => {
    const many = Array.from(
      { length: MAX_FIND_MATCHES + 7 },
      (_, i) => `- button "Reply ${i}" [ref=e${i + 1}]`,
    ).join("\n")
    const { matches, total } = findInSnapshot(parseSnapshot(many), "reply")

    expect(matches).toHaveLength(MAX_FIND_MATCHES)
    expect(total).toBe(MAX_FIND_MATCHES + 7)
  })
})

describe("a snapshot's masked fields", () => {
  const TREE = `- generic [ref=e1]:
  - textbox "Email" [ref=e2]: ada@example.com
  - textbox "Password" [active] [ref=e3]: hunter2
  - 'textbox "Key: main" [ref=e4]': "hunter2"
  - searchbox "Find" [ref=e5]: hunter2
  - paragraph [ref=e6]: hunter2
  - text: hunter2`

  it("shows a field's value as its mask, and leaves the rest of the page as it is", () => {
    expect(maskFields(TREE, new Map([["hunter2", PASSWORD_MASK]]))).toBe(
      `- generic [ref=e1]:
  - textbox "Email" [ref=e2]: ada@example.com
  - textbox "Password" [active] [ref=e3]: [password]
  - 'textbox "Key: main" [ref=e4]': [password]
  - searchbox "Find" [ref=e5]: [password]
  - paragraph [ref=e6]: hunter2
  - text: hunter2`,
    )
  })

  it("names the secret a field holds", () => {
    expect(
      maskFields(TREE, new Map([["ada@example.com", secretMask("Mail")]])),
    ).toContain('textbox "Email" [ref=e2]: [secret: Mail]')
    expect(maskFields(TREE, new Map())).toBe(TREE)
  })
})

describe("a snapshot's words", () => {
  it("reads as lines: headings, links with their address, items, no refs and no field's value", () => {
    const text = snapshotText(parseSnapshot(SAMPLE))

    expect(text.split("\n")).toEqual([
      "[Home](/a)",
      '# Who "are" you?',
      "Name",
      "Menu",
      "- Hi there: yes",
      "[Hi there](/x)",
      "Tab 1",
      "## Time: now",
      "Inner",
      "Hi there",
      "f",
    ])
    expect(text).not.toContain("ref")
  })
})
