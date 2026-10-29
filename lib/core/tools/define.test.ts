import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  applyAliases,
  defineTool,
  toolJsonSchema,
  undescribedProperties,
} from "./define"
import { ok } from "./outcome"

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

function tool(input: z.ZodObject, name = "a_tool") {
  return defineTool({
    name,
    title: "A tool",
    description: "Does one thing.",
    input,
    annotations,
    run: async () => ok("done"),
  })
}

describe("defineTool", () => {
  it("refuses a name MCP does not allow", () => {
    expect(() => tool(z.object({}), "has space")).toThrow(/1 to 128/)
    expect(() => tool(z.object({}), "x".repeat(129))).toThrow(/1 to 128/)
    expect(() => tool(z.object({}), "ok.name-1_2")).not.toThrow()
  })

  it("publishes JSON Schema 2020-12 with every object closed", () => {
    const schema = tool(
      z.object({
        query: z.string().max(10).describe("What to find."),
        limit: z.number().int().min(1).optional().describe("How many."),
        filters: z
          .array(
            z.object({
              field: z.string().describe("A field."),
              value: z.unknown().describe("Its value."),
            }),
          )
          .optional()
          .describe("Filters."),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Anything else, as the API takes it."),
      }),
    ).inputSchema()

    expect(schema.$schema).toBeUndefined()
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["query"],
    })
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >
    // zod's safe-integer bounds are noise.
    expect(properties.limit).toEqual({
      type: "integer",
      minimum: 1,
      description: "How many.",
    })
    expect(
      (properties.filters!.items as Record<string, unknown>)
        .additionalProperties,
    ).toBe(false)
    // A record stays open, as it says.
    expect(properties.extra!.additionalProperties).toEqual({})
  })

  it("publishes a tool without arguments as a closed empty object", () => {
    expect(tool(z.object({})).inputSchema()).toEqual({
      type: "object",
      additionalProperties: false,
    })
  })

  it("refuses an argument without a description, wherever it is", () => {
    const missing = tool(
      z.object({
        a: z.string().describe("Described."),
        b: z.string(),
        c: z.array(z.object({ d: z.string() })).describe("A list of objects."),
      }),
    )

    expect(() => missing.inputSchema()).toThrow(
      "a_tool's input schema has properties without a description: /b, /c/[]/d.",
    )
  })

  it("publishes an output union as an object", () => {
    const output = toolJsonSchema(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a") }),
        z.object({ kind: z.literal("b"), n: z.number() }),
      ]),
      "output",
    )

    expect(output.type).toBe("object")
    expect(output.$schema).toBeUndefined()
    expect(Array.isArray(output.oneOf)).toBe(true)
  })

  it("finds undescribed properties inside unions and definitions", () => {
    expect(
      undescribedProperties({
        type: "object",
        properties: {
          v: {
            description: "x",
            anyOf: [{ type: "object", properties: { w: { type: "string" } } }],
          },
        },
        $defs: { d: { properties: { e: {} } } },
      }),
    ).toEqual(["/v/anyOf/0/w", "/$defs/d/e"])
  })
})

describe("applyAliases", () => {
  it("renames an old name and says so, leaving what was sent alone", () => {
    const sent = { addPatches: [1], name: "x" }
    const renamed = applyAliases(sent, { addPatches: "add_patches" })

    expect(renamed.args).toEqual({ add_patches: [1], name: "x" })
    expect(renamed.notes).toEqual([
      "addPatches was renamed to add_patches; use add_patches.",
    ])
    expect(sent).toEqual({ addPatches: [1], name: "x" })
  })

  it("renames inside the items of a list, once per name", () => {
    const renamed = applyAliases(
      {
        tools: [
          { name: "a", inputSchema: {} },
          { name: "b", inputSchema: { type: "object" } },
          { name: "c", input_schema: {} },
        ],
      },
      { "tools[].inputSchema": "input_schema" },
    )

    expect(renamed.args).toEqual({
      tools: [
        { name: "a", input_schema: {} },
        { name: "b", input_schema: { type: "object" } },
        { name: "c", input_schema: {} },
      ],
    })
    expect(renamed.notes).toEqual([
      "tools[].inputSchema was renamed to input_schema; use input_schema.",
    ])
  })

  it("refuses both names at once", () => {
    expect(
      applyAliases(
        { readOnly: true, read_only: false },
        { readOnly: "read_only" },
      ).conflict,
    ).toBe("readOnly was renamed to read_only: pass only read_only.")
  })

  it("does nothing without aliases", () => {
    const sent = { a: 1 }

    expect(applyAliases(sent, undefined)).toEqual({ args: sent, notes: [] })
  })
})
