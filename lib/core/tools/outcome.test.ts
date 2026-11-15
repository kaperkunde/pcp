import { describe, expect, it } from "vitest"

import { PcpError } from "../errors"
import {
  ERROR_META_KEY,
  errorCodeOf,
  errorOutcome,
  needsOwner,
  ok,
  passOn,
  toCallToolResult,
  toolError,
  withLead,
} from "./outcome"

describe("toCallToolResult", () => {
  it("answers a structured value as structuredContent and its JSON", () => {
    expect(toCallToolResult(ok({ a: 1 }), { structured: true })).toEqual({
      content: [{ type: "text", text: '{\n "a": 1\n}' }],
      structuredContent: { a: 1 },
    })
    expect(
      toCallToolResult(ok({ a: 1 }, { text: "One a." }), { structured: true }),
    ).toEqual({
      content: [{ type: "text", text: "One a." }],
      structuredContent: { a: 1 },
    })
  })

  it("answers prose as text alone", () => {
    expect(toCallToolResult(ok("Done."))).toEqual({
      content: [{ type: "text", text: "Done." }],
    })
  })

  it("keeps an error's code and hint", () => {
    const result = toCallToolResult(
      toolError("No server called x.", {
        code: "not_found",
        hint: "search finds them.",
      }),
    )

    expect(result).toEqual({
      content: [
        { type: "text", text: "No server called x.\n\nsearch finds them." },
      ],
      isError: true,
      _meta: {
        [ERROR_META_KEY]: { code: "not_found", hint: "search finds them." },
      },
    })
    expect(errorCodeOf(result)).toBe("not_found")
    expect(errorCodeOf({ content: [] })).toBeUndefined()
  })

  it("marks a call that waits for the owner, its link last", () => {
    const owner = {
      kind: "needs_owner" as const,
      reason: "permission" as const,
      url: "https://pcp.x/permissions/r1",
      label: "Answer the request in PCP",
      request: "r1",
    }
    const result = toCallToolResult(
      needsOwner(owner, "Not done yet.\n\nhttps://pcp.x/permissions/r1"),
    )

    expect(result.structuredContent).toEqual(owner)
    expect(result.isError).toBeUndefined()
  })

  it("passes on an answer made elsewhere, notes in front", () => {
    const answer = { content: [{ type: "text" as const, text: "ran" }] }

    expect(toCallToolResult(passOn(answer))).toBe(answer)
    expect(
      toCallToolResult(passOn(answer), {
        notes: ["a was renamed to b; use b."],
      }).content,
    ).toEqual([
      { type: "text", text: "a was renamed to b; use b." },
      { type: "text", text: "ran" },
    ])
  })
})

describe("errorOutcome", () => {
  it("keeps a PcpError's words and code, and hides anything else", () => {
    expect(errorOutcome(new PcpError("forbidden", "Not yours."))).toEqual({
      type: "error",
      message: "Not yours.",
      code: "forbidden",
    })
    expect(errorOutcome(new Error("stack details"))).toEqual({
      type: "error",
      message: "Something went wrong inside PCP.",
      code: "internal",
    })
  })
})

describe("withLead", () => {
  it("puts a line in front of every kind of text", () => {
    expect(withLead("Lead.", ok("Body."))).toEqual(ok("Lead.\n\nBody."))
    expect(withLead("Lead.", toolError("Bad."))).toMatchObject({
      message: "Lead.\n\nBad.",
    })
    expect(
      toCallToolResult(
        withLead(
          "Lead.",
          passOn({ content: [{ type: "text", text: "Asked." }] }),
        ),
      ).content,
    ).toEqual([{ type: "text", text: "Lead.\n\nAsked." }])
  })
})
