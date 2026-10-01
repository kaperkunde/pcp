import { describe, expect, it } from "vitest"

import { toJsonSchema } from "./schema"

describe("toJsonSchema", () => {
  it("passes JSON Schema keywords through and recurses", () => {
    expect(
      toJsonSchema(
        {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "integer", minimum: 1 },
            tags: { type: "array", items: { type: "string", maxLength: 5 } },
          },
        },
        "3.1.0",
      ),
    ).toEqual({
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        tags: { type: "array", items: { type: "string", maxLength: 5 } },
      },
    })
  })

  it("turns 3.0 nullable into a null type", () => {
    expect(toJsonSchema({ type: "string", nullable: true }, "3.0.3")).toEqual({
      type: ["string", "null"],
    })
    expect(
      toJsonSchema({ type: "string", enum: ["a"], nullable: true }, "3.0.3"),
    ).toEqual({ type: ["string", "null"], enum: ["a", null] })
    expect(toJsonSchema({ nullable: true, description: "x" }, "3.0.3")).toEqual(
      { anyOf: [{ description: "x" }, { type: "null" }] },
    )
  })

  it("turns 3.0 boolean exclusive bounds into numbers", () => {
    expect(
      toJsonSchema(
        { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 9 },
        "3.0.0",
      ),
    ).toEqual({ type: "number", exclusiveMinimum: 0, maximum: 9 })
    expect(
      toJsonSchema({ type: "number", exclusiveMinimum: 2 }, "3.1.0"),
    ).toEqual({ type: "number", exclusiveMinimum: 2 })
  })

  it("keeps example as examples", () => {
    expect(toJsonSchema({ type: "string", example: "x" }, "3.0.0")).toEqual({
      type: "string",
      examples: ["x"],
    })
  })

  it("leaves out readOnly properties, and drops them from required", () => {
    expect(
      toJsonSchema(
        {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "integer", readOnly: true },
            name: { type: "string" },
          },
        },
        "3.0.0",
      ),
    ).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    })
  })

  it("drops generator-only keywords and implies a type", () => {
    expect(
      toJsonSchema(
        {
          properties: {
            a: { type: "string", xml: { name: "a" }, "x-extra": 1 },
          },
          discriminator: { propertyName: "a" },
          externalDocs: { url: "https://x" },
        },
        "3.0.0",
      ),
    ).toEqual({ type: "object", properties: { a: { type: "string" } } })
  })

  it("skips a __proto__ property", () => {
    const schema = toJsonSchema(
      JSON.parse('{"properties":{"__proto__":{"type":"string"},"ok":{}}}'),
      "3.0.0",
    ) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(["ok"])
  })
})
