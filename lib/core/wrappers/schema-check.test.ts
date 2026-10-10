import { describe, expect, it } from "vitest"

import { checkValue, hasReference } from "./schema-check"

describe("checkValue", () => {
  const order = {
    type: "object",
    properties: {
      id: { type: "integer" },
      status: { enum: ["open", "paid"] },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: { total: { type: "number" } },
          required: ["total"],
        },
      },
      note: { type: ["string", "null"] },
    },
    required: ["id", "status"],
    additionalProperties: false,
  }

  it("passes a value that fits", () => {
    expect(
      checkValue(order, {
        id: 4,
        status: "paid",
        lines: [{ total: 1.5 }],
        note: null,
      }),
    ).toBeNull()
  })

  it("names the type that is wrong and where", () => {
    expect(checkValue(order, { id: "4", status: "open" })).toBe(
      '"/id" is string, but the outputSchema says integer.',
    )
    expect(checkValue({ type: "array" }, {})).toBe(
      "The answer is object, but the outputSchema says array.",
    )
    expect(
      checkValue(order, { id: 1, status: "open", lines: [{ total: 1 }, {}] }),
    ).toBe('"/lines/1" has no "total", which the outputSchema requires.')
  })

  it("checks required, enum, const and additional properties", () => {
    expect(checkValue(order, { id: 1 })).toContain('no "status"')
    expect(checkValue(order, { id: 1, status: "void" })).toContain("enum")
    expect(checkValue(order, { id: 1, status: "open", x: 1 })).toContain(
      'has "x"',
    )
    expect(checkValue({ const: 3 }, 4)).toContain("const")
    expect(
      checkValue(
        { type: "object", additionalProperties: { type: "number" } },
        { a: 1, b: "x" },
      ),
    ).toContain('"/b" is string')
  })

  it("escapes a key in the place it names", () => {
    expect(
      checkValue({ properties: { "a/b": { type: "string" } } }, { "a/b": 1 }),
    ).toContain('"/a~1b"')
  })

  it("follows anyOf, oneOf and allOf", () => {
    const either = { anyOf: [{ type: "string" }, { type: "number" }] }
    expect(checkValue(either, 1)).toBeNull()
    expect(checkValue(either, true)).toContain("matches none")
    expect(
      checkValue({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1),
    ).toContain("more than one")
    expect(
      checkValue(
        { allOf: [{ type: "object" }, { required: ["a"] }] },
        { b: 1 },
      ),
    ).toContain('no "a"')
  })

  it("says nothing about what the schema does not cover", () => {
    expect(checkValue({}, { anything: [1, "x"] })).toBeNull()
    expect(checkValue(true, 1)).toBeNull()
    expect(checkValue(false, 1)).toContain("not allowed")
    expect(checkValue({ type: "unheard-of" }, 1)).toBeNull()
  })

  it("stops at a value too large, or nested too deep, to check", () => {
    expect(
      checkValue({ items: { type: "number" } }, new Array(100_001).fill(1)),
    ).toContain("more than 100,000 values")

    let deep: unknown = 1
    let schema: unknown = { type: "number" }
    for (let level = 0; level < 40; level++) {
      deep = [deep]
      schema = { items: schema }
    }
    expect(checkValue(schema, deep)).toContain("levels deep")
  })
})

describe("hasReference", () => {
  it("finds a $ref wherever it is", () => {
    expect(hasReference({ type: "object" })).toBe(false)
    expect(hasReference({ properties: { a: { $ref: "#/x" } } })).toBe(true)
    expect(hasReference({ anyOf: [{ type: "string" }, { $ref: "#/x" }] })).toBe(
      true,
    )
  })

  it("counts a schema too big to look through as one", () => {
    const wide = { anyOf: new Array(20_001).fill({ type: "string" }) }
    expect(hasReference(wide)).toBe(true)
  })
})
