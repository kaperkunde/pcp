import { describe, expect, it } from "vitest"

import {
  CONFLICT_END,
  CONFLICT_MIDDLE,
  CONFLICT_START,
  diffLines,
  hasConflictMarkers,
  mergeLines,
} from "./line-merge"

const BASE = ["- one", "- two", "- three", "- four"].join("\n")

describe("mergeLines", () => {
  it("takes each side's changes when they touch different lines", () => {
    const mine = ["- one, my way", "- two", "- three", "- four"].join("\n")
    const theirs = [
      "- one",
      "- two",
      "- three",
      "- four, PCP's way",
      "- five",
    ].join("\n")

    expect(mergeLines(BASE, mine, theirs)).toEqual({
      text: [
        "- one, my way",
        "- two",
        "- three",
        "- four, PCP's way",
        "- five",
      ].join("\n"),
      conflicts: 0,
    })
  })

  it("keeps a line one side removed out, and one both added once", () => {
    const mine = ["- one", "- three", "- four", "- extra"].join("\n")
    const theirs = ["- one", "- two", "- three", "- four", "- extra"].join("\n")

    expect(mergeLines(BASE, mine, theirs)).toEqual({
      text: ["- one", "- three", "- four", "- extra"].join("\n"),
      conflicts: 0,
    })
  })

  it("marks a line both sides changed differently, for a person to settle", () => {
    const mine = ["- one", "- two, mine", "- three", "- four"].join("\n")
    const theirs = ["- one", "- two, PCP's", "- three", "- four"].join("\n")
    const merged = mergeLines(BASE, mine, theirs)

    expect(merged.conflicts).toBe(1)
    expect(merged.text).toBe(
      [
        "- one",
        CONFLICT_START,
        "- two, mine",
        CONFLICT_MIDDLE,
        "- two, PCP's",
        CONFLICT_END,
        "- three",
        "- four",
      ].join("\n"),
    )
    expect(hasConflictMarkers(merged.text)).toBe(true)
  })

  it("is the other side when one side did not change", () => {
    const changed = ["- one", "- two", "- 3"].join("\n")

    expect(mergeLines(BASE, BASE, changed)).toEqual({
      text: changed,
      conflicts: 0,
    })
    expect(mergeLines(BASE, changed, BASE)).toEqual({
      text: changed,
      conflicts: 0,
    })
    expect(mergeLines(BASE, changed, changed)).toEqual({
      text: changed,
      conflicts: 0,
    })
  })

  it("merges against an empty base as two texts with nothing in common", () => {
    const merged = mergeLines("", "mine", "theirs")

    expect(merged.conflicts).toBe(1)
    expect(merged.text).toContain("mine")
    expect(merged.text).toContain("theirs")
  })
})

describe("hasConflictMarkers", () => {
  it("finds the marker lines only", () => {
    expect(hasConflictMarkers("a\n=======\nb")).toBe(true)
    expect(hasConflictMarkers("<<<<<<< Yours\na")).toBe(true)
    expect(hasConflictMarkers("a ======= b\n<<< not one")).toBe(false)
  })
})

describe("diffLines", () => {
  it("keeps the lines both have, and says which went and which came", () => {
    expect(diffLines(BASE, "- one\n- 2\n- three\n- four\n- five")).toEqual([
      { kind: "same", text: "- one" },
      { kind: "removed", text: "- two" },
      { kind: "added", text: "- 2" },
      { kind: "same", text: "- three" },
      { kind: "same", text: "- four" },
      { kind: "added", text: "- five" },
    ])
    expect(diffLines("", "new")).toEqual([{ kind: "added", text: "new" }])
    expect(diffLines("old", "")).toEqual([{ kind: "removed", text: "old" }])
  })
})
