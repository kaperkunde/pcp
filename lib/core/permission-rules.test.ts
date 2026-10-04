import { describe, expect, it } from "vitest"

import {
  canonicalJson,
  decisionsFor,
  isOpen,
  parseDecision,
  previewArgs,
  requestHash,
  storedResultText,
  summaryText,
} from "./permission-rules"

describe("canonicalJson and requestHash", () => {
  it("does not depend on key order or undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, 2] }, b: 1 }),
    )
    expect(requestHash("call", "s/send", { to: "x", message: "hi" })).toBe(
      requestHash("call", "s/send", { message: "hi", to: "x" }),
    )
  })

  it("tells kinds, targets and arguments apart", () => {
    const base = requestHash("call", "s/send", { to: "x" })

    expect(requestHash("register", "s/send", { to: "x" })).not.toBe(base)
    expect(requestHash("call", "s/other", { to: "x" })).not.toBe(base)
    expect(requestHash("call", "s/send", { to: "y" })).not.toBe(base)
    expect(requestHash("call", "s/send", { to: "x", extra: null })).not.toBe(
      base,
    )
  })

  it("keeps array order, which can matter", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})

describe("previewArgs", () => {
  it("puts one argument on each line", () => {
    expect(previewArgs({ to: "Ada", count: 2, tags: ["a", "b"] })).toEqual([
      "to: Ada",
      "count: 2",
      'tags: ["a","b"]',
    ])
  })

  it("says so when there are none, and clips long values", () => {
    expect(previewArgs({})).toEqual(["(no arguments)"])
    expect(previewArgs({ body: "x".repeat(20) }, 10)).toEqual([
      "body: xxxxxxxxx…",
    ])
  })
})

describe("summaryText", () => {
  it("puts the title, the details and the warning on their own lines", () => {
    expect(
      summaryText({
        title: "Allow postcards/send_postcard?",
        lines: ["to: Ada"],
        warning: "It cannot be undone.",
      }),
    ).toBe("Allow postcards/send_postcard?\n- to: Ada\nIt cannot be undone.")
  })
})

describe("storedResultText", () => {
  it("cuts long results", () => {
    expect(storedResultText(["x".repeat(30)], 10)).toBe(
      "xxxxxxxxxx\n… (truncated)",
    )
  })

  it("keeps the notes the cut would lose", () => {
    expect(
      storedResultText(["x".repeat(30), "NOTE"], 10, ["NOTE", "GONE?"]),
    ).toBe("xxxxxxxxxx\n… (truncated)\nNOTE\nGONE?")
    expect(storedResultText(["NOTE", "x".repeat(30)], 10, ["NOTE"])).toBe(
      "NOTE\nxxxxx\n… (truncated)",
    )
  })
})

describe("isOpen", () => {
  const now = new Date("2026-09-30T12:00:00Z")

  it("is open while pending and not expired", () => {
    expect(
      isOpen(
        { status: "pending", expiresAt: new Date("2026-10-01T11:00:00Z") },
        now,
      ),
    ).toBe(true)
  })

  it("closes on expiry or once answered", () => {
    expect(
      isOpen(
        { status: "pending", expiresAt: new Date("2026-09-30T11:59:59Z") },
        now,
      ),
    ).toBe(false)
    expect(
      isOpen(
        { status: "executed", expiresAt: new Date("2026-10-01T11:00:00Z") },
        now,
      ),
    ).toBe(false)
  })
})

describe("decisions", () => {
  it("offers four answers for a call and two for a new server", () => {
    expect(decisionsFor("call").map((decision) => decision.label)).toEqual([
      "Allow once",
      "Always allow",
      "Block",
      "Not now",
    ])
    expect(decisionsFor("register").map((decision) => decision.value)).toEqual([
      "allow_once",
      "decline",
    ])
  })

  it("offers a memory to share three ways, and a change to a shared one two", () => {
    expect(
      decisionsFor("memory_share").map((decision) => decision.value),
    ).toEqual(["allow_once", "decline", "discard"])
    expect(
      decisionsFor("memory_change").map((decision) => decision.value),
    ).toEqual(["allow_once", "decline"])
    expect(() => parseDecision("call", "discard")).toThrow(/allow_once/)
    expect(() => parseDecision("memory_change", "discard")).toThrow()
  })

  it("offers proposed tool levels no answer but no", () => {
    expect(decisionsFor("access").map((decision) => decision.value)).toEqual([
      "decline",
    ])
    expect(() => parseDecision("access", "allow_once")).toThrow()
    expect(() => parseDecision("access", "always")).toThrow()
  })

  it("accepts only the answers it offered", () => {
    expect(parseDecision("call", "always")).toBe("always")
    expect(() => parseDecision("register", "always")).toThrow(/allow_once/)
    expect(() => parseDecision("call", "yes")).toThrow()
    expect(() => parseDecision("call", undefined)).toThrow()
  })
})
