import { describe, expect, it } from "vitest"
import { z } from "zod"

import { invalid, PcpError } from "../errors"
import {
  argumentsResult,
  defineInnerTool,
  exactlyOne,
  refusalOf,
} from "./family"

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

const tool = defineInnerTool({
  name: "find_things",
  title: "Find things",
  description: "Finds things.",
  input: z.strictObject({
    text: z.string().min(1).describe("What to find."),
    ref: z.string().optional().describe("Where."),
    target: z.string().optional().describe("Or where, by name."),
    max_count: z
      .number()
      .int()
      .optional()
      .refine((value) => value !== 13, { message: "Not 13." })
      .describe("How many."),
  }),
  rules: [
    exactlyOne(["ref", "target"], "Give a ref or a target, one of them."),
  ],
  aliases: { maxCount: "max_count" },
  retired: { limit: "max_count" },
  synonyms: { query: "text" },
  annotations,
})

describe("defineInnerTool", () => {
  it("publishes the rules under allOf, beside a closed schema", () => {
    expect(tool.inputSchema()).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["text"],
      allOf: [{ oneOf: [{ required: ["ref"] }, { required: ["target"] }] }],
    })
    expect(tool.listed("Finds things here.")).toMatchObject({
      name: "find_things",
      description: "Finds things here.",
    })
  })

  it("refuses a property without a description when the schema is made", () => {
    const bad = defineInnerTool({
      name: "bad",
      title: "Bad",
      description: "Bad.",
      input: z.strictObject({ x: z.string() }),
      annotations,
    })

    expect(() => bad.inputSchema()).toThrow(/without a description: \/x/)
  })

  it("checks the schema, then each rule in its own words, then zod", () => {
    expect(tool.check({ text: "a", ref: "e1" })).toEqual({
      fits: true,
      args: { text: "a", ref: "e1" },
      notes: [],
      renames: [],
    })
    expect(tool.check({ text: "", other: 1 })).toMatchObject({
      fits: false,
      problems: [
        '"text" is 0 characters long, but the inputSchema says at least 1.',
        '"other" is not an argument of this tool (it takes: text, ref, target, max_count).',
      ],
    })
    expect(tool.check({ text: "a", ref: "e1", target: "x" })).toMatchObject({
      fits: false,
      problems: ["Give a ref or a target, one of them."],
    })
    expect(tool.check({ text: "a", ref: "e1", max_count: 13 })).toMatchObject({
      fits: false,
      problems: ['"max_count": Not 13.'],
    })
  })

  it("renames an alias with a note, refuses a retired name and takes a synonym quietly", () => {
    expect(tool.check({ text: "a", ref: "e1", maxCount: 2 })).toEqual({
      fits: true,
      args: { text: "a", ref: "e1", max_count: 2 },
      notes: ["maxCount was renamed to max_count; use max_count."],
      renames: [{ from: "maxCount", to: "max_count", retired: false }],
    })
    expect(tool.check({ text: "a", ref: "e1", limit: 2 })).toMatchObject({
      fits: false,
      problems: [
        "limit was renamed to max_count, and the old name is no longer taken: use max_count.",
      ],
      renames: [{ from: "limit", to: "max_count", retired: true }],
    })
    expect(tool.check({ query: "a", ref: "e1" })).toMatchObject({
      fits: true,
      args: { text: "a", ref: "e1" },
      notes: [],
    })
    expect(tool.check({ query: "a", text: "b", ref: "e1" })).toMatchObject({
      fits: false,
      problems: ["query is another name for text; give one of them."],
    })
  })
})

describe("a family's refusals", () => {
  it("carry their code, and say nothing was done", () => {
    expect(argumentsResult("mail/search_emails", ["x is wrong."])).toEqual({
      content: [
        {
          type: "text",
          text: "These arguments do not fit mail/search_emails's inputSchema, so nothing was done:\n- x is wrong.",
        },
      ],
      isError: true,
      _meta: { "gg.pcp/error": { code: "invalid_arguments" } },
    })
  })

  it("turn a thrown refusal into a tool error, and leave a failure on the way to be thrown", () => {
    expect(refusalOf(invalid("to is not after from."), "cal/x")).toMatchObject({
      isError: true,
      _meta: { "gg.pcp/error": { code: "invalid_arguments" } },
    })
    expect(
      refusalOf(new PcpError("state", "No such calendar."), "cal/x"),
    ).toMatchObject({ _meta: { "gg.pcp/error": { code: "state" } } })
    expect(refusalOf(new PcpError("upstream", "down"), "cal/x")).toBeNull()
    expect(refusalOf(new PcpError("unauthorized", "no"), "cal/x")).toBeNull()
    expect(refusalOf(new Error("bug"), "cal/x")).toBeNull()
  })
})
