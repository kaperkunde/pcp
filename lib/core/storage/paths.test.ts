import { describe, expect, it } from "vitest"

import {
  globMatcher,
  isInside,
  normalizeRootPath,
  relativeTo,
  splitPath,
  under,
} from "./paths"

describe("a path inside a storage root", () => {
  it("is split into names, the root as empty", () => {
    expect(splitPath("")).toEqual([])
    expect(splitPath("/")).toEqual([])
    expect(splitPath("./scans//2026/")).toEqual(["scans", "2026"])
    expect(splitPath("/scans/a.pdf")).toEqual(["scans", "a.pdf"])
  })

  it("never climbs out with ..", () => {
    expect(() => splitPath("../etc/passwd")).toThrow(/leave out \.\./)
    expect(() => splitPath("scans/../../x")).toThrow(/leave out \.\./)
    expect(() => splitPath("a\u0000b")).toThrow(/NUL/)
    expect(() => splitPath(`${"x".repeat(256)}`)).toThrow(/255 bytes/)
  })

  it("counts a sibling with the same start as outside", () => {
    expect(isInside("/srv/a", "/srv/a")).toBe(true)
    expect(isInside("/srv/a", "/srv/a/b")).toBe(true)
    expect(isInside("/srv/a", "/srv/a2")).toBe(false)
    expect(isInside("/srv/a", "/srv")).toBe(false)
    expect(isInside("/", "/anything")).toBe(true)
    expect(relativeTo("/srv/a", "/srv/a/b/c")).toEqual(["b", "c"])
    expect(under("/srv/a", ["b", "c"])).toBe("/srv/a/b/c")
  })

  it("takes a root's own path only as a full path below /", () => {
    expect(normalizeRootPath(" /srv/files/ ")).toBe("/srv/files")
    expect(() => normalizeRootPath("srv/files")).toThrow(/starting with \//)
    expect(() => normalizeRootPath("/")).toThrow(/whole file system/)
    expect(() => normalizeRootPath("/srv/../etc")).toThrow(/\.\./)
  })
})

describe("find_files's name pattern", () => {
  it("matches names with * ? and [ ]", () => {
    const pdf = globMatcher("*.pdf")
    expect(pdf("Invoice.PDF")).toBe(true)
    expect(pdf("invoice.pdf.txt")).toBe(false)

    const month = globMatcher("invoice-2026-??.pdf")
    expect(month("invoice-2026-03.pdf")).toBe(true)
    expect(month("invoice-2026-3.pdf")).toBe(false)

    expect(globMatcher("[a-c]*")("beta")).toBe(true)
    expect(globMatcher("[!a-c]*")("beta")).toBe(false)
    expect(globMatcher("a+b(1).txt")("a+b(1).txt")).toBe(true)
    expect(globMatcher("A.txt", { caseSensitive: true })("a.txt")).toBe(false)
  })

  it("refuses a slash and an empty pattern", () => {
    expect(() => globMatcher("scans/*.pdf")).toThrow(/without a slash/)
    expect(() => globMatcher("")).toThrow(/1 to/)
  })
})
