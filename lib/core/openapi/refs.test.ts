import { describe, expect, it } from "vitest"

import {
  derefShallow,
  inlineRefs,
  resolvePointer,
  UnsupportedRef,
} from "./refs"

const doc = {
  components: {
    schemas: {
      "a/b": { type: "string" },
      Pet: {
        type: "object",
        properties: { name: { $ref: "#/components/schemas/a~1b" } },
      },
      Node: {
        type: "object",
        properties: {
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/Node" },
          },
        },
      },
    },
    parameters: { Limit: { name: "limit", in: "query" } },
  },
}

describe("resolvePointer", () => {
  it("decodes ~1 and ~0 and percent escapes", () => {
    expect(resolvePointer(doc, "#/components/schemas/a~1b")).toEqual({
      type: "string",
    })
    expect(resolvePointer(doc, "#/components/schemas/a%2Fb")).toEqual({
      type: "string",
    })
  })

  it("never follows a reference out of the document", () => {
    for (const ref of [
      "https://evil.example/x.json#/a",
      "other.yaml#/a",
      "//evil.example/x",
      "file:///etc/passwd",
    ]) {
      expect(() => resolvePointer(doc, ref)).toThrow(UnsupportedRef)
    }
  })

  it("does not reach into the prototype", () => {
    for (const ref of [
      "#/__proto__",
      "#/constructor",
      "#/components/constructor/prototype",
      "#/components/schemas/toString",
    ]) {
      expect(() => resolvePointer(doc, ref)).toThrow(/missing/)
    }
  })
})

describe("inlineRefs", () => {
  it("inlines nested references", () => {
    expect(inlineRefs(doc, { $ref: "#/components/schemas/Pet" })).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    })
  })

  it("cuts a reference back into itself instead of failing", () => {
    const result = inlineRefs(doc, {
      $ref: "#/components/schemas/Node",
    }) as { properties: { children: { items: unknown } } }
    expect(result.properties.children.items).toEqual({
      description: "Recursive reference to Node.",
    })
  })

  it("lays sibling keys over the target", () => {
    expect(
      inlineRefs(doc, {
        $ref: "#/components/schemas/a~1b",
        description: "A name.",
      }),
    ).toEqual({ type: "string", description: "A name." })
  })

  it("reports an external or missing target, with a reason for the owner", () => {
    const reasonOf = (ref: string) => {
      try {
        inlineRefs(doc, { $ref: ref })
      } catch (error) {
        return error instanceof UnsupportedRef ? error : null
      }
      return null
    }

    expect(reasonOf("http://x/y")?.reason).toBe("external")
    expect(reasonOf("http://x/y")?.describe()).toMatch(/another document/)
    expect(reasonOf("#/nope")?.reason).toBe("missing")
    expect(reasonOf("#/nope")?.describe()).toMatch(/does not define/)
  })

  it("stops a schema whose references fan out exponentially", () => {
    // Shallow but wide: 10 references at each of 6 levels is a million
    // nodes when inlined, far past the budget, and well inside the depth.
    const bomb: Record<string, unknown> = { l0: { type: "string" } }
    for (let i = 1; i <= 6; i++) {
      bomb[`l${i}`] = {
        allOf: Array.from({ length: 10 }, () => ({ $ref: `#/l${i - 1}` })),
      }
    }
    const started = Date.now()
    expect(() => inlineRefs(bomb, { $ref: "#/l6" })).toThrow(
      expect.objectContaining({ reason: "too_large" }),
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("stops a schema nested deeper than it reads", () => {
    const deep: Record<string, unknown> = { l0: { type: "string" } }
    for (let i = 1; i <= 100; i++) {
      deep[`l${i}`] = { items: { $ref: `#/l${i - 1}` } }
    }
    expect(() => inlineRefs(deep, { $ref: "#/l100" })).toThrow(
      expect.objectContaining({ reason: "too_deep" }),
    )
  })

  it("does not copy __proto__ keys", () => {
    const hostile = JSON.parse('{"a":{"__proto__":{"polluted":true}}}')
    const copy = inlineRefs({}, hostile) as Record<string, unknown>
    expect(Object.getPrototypeOf(copy.a)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("derefShallow", () => {
  it("follows a parameter reference and refuses a loop", () => {
    expect(
      derefShallow(doc, { $ref: "#/components/parameters/Limit" }),
    ).toEqual({ name: "limit", in: "query" })

    const loop = { a: { $ref: "#/b" }, b: { $ref: "#/a" } }
    expect(() => derefShallow(loop, { $ref: "#/a" })).toThrow(UnsupportedRef)
  })
})
