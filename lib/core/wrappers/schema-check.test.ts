import { describe, expect, it } from "vitest"

import { hasReference } from "./schema-check"

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
