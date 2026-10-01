import { describe, expect, it } from "vitest"

import { MAX_PATCH_OPERATIONS, MAX_SPEC_NODES } from "./limits"
import { parseSpecText } from "./parse"
import {
  applyPatches,
  parsePointer,
  readPatches,
  readStoredPatches,
  valueAt,
} from "./patch"

const doc = () => ({
  openapi: "3.0.3",
  servers: [{ url: "https://demo.example.com" }],
  paths: {
    "/pets": {
      get: {
        parameters: [{ $ref: "#/components/parameters/XRequestedWith" }],
      },
    },
    "/login": { post: {} },
  },
  components: {
    parameters: {
      XRequestedWith: {
        name: "X-Requested-With",
        in: "header",
        required: true,
      },
    },
  },
})

describe("parsePointer", () => {
  it("unescapes ~1 and ~0 and reads the empty pointer as the whole document", () => {
    expect(parsePointer("")).toEqual([])
    expect(parsePointer("/paths/~1api~1v1~1pets/get")).toEqual([
      "paths",
      "/api/v1/pets",
      "get",
    ])
    expect(parsePointer("/a~01")).toEqual(["a~1"])
  })

  it("refuses what is not a pointer, a stray ~ and __proto__", () => {
    expect(() => parsePointer("paths")).toThrow(/starts with "\/"/)
    expect(() => parsePointer("/a~2")).toThrow(/~0 or ~1/)
    expect(() => parsePointer("/a~")).toThrow(/~0 or ~1/)
    expect(() => parsePointer("/__proto__/x")).toThrow(/__proto__/)
  })
})

describe("readPatches", () => {
  it("keeps only the fields each operation uses", () => {
    expect(
      readPatches([
        { op: "remove", path: "/a", value: 1, extra: true },
        { op: "copy", from: "/a", path: "/b" },
        { op: "add", path: "/c", value: null },
      ]),
    ).toEqual([
      { op: "remove", path: "/a" },
      { op: "copy", from: "/a", path: "/b" },
      { op: "add", path: "/c", value: null },
    ])
  })

  it("names the edit that is wrong", () => {
    expect(() => readPatches({ op: "add" })).toThrow(/a list of operations/)
    expect(() => readPatches([{ op: "merge", path: "/a" }])).toThrow(
      /Edit 1: op is one of/,
    )
    expect(() =>
      readPatches([
        { op: "remove", path: "/a" },
        { op: "add", path: "/b" },
      ]),
    ).toThrow(/Edit 2: add needs a value/)
    expect(() => readPatches([{ op: "move", path: "/a" }])).toThrow(
      /Edit 1: move needs from/,
    )
    expect(() => readPatches([{ op: "remove", path: "a" }])).toThrow(
      /Edit 1: "a" is not a JSON Pointer/,
    )
  })

  it("refuses more edits than an endpoint keeps", () => {
    const many = Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => ({
      op: "remove",
      path: "/a",
    }))
    expect(() => readPatches(many)).toThrow(/at most/)
  })

  it("reads back what was stored, and nothing when nothing was", () => {
    expect(readStoredPatches(null)).toEqual([])
    expect(readStoredPatches('[{"op":"remove","path":"/a"}]')).toEqual([
      { op: "remove", path: "/a" },
    ])
    expect(() => readStoredPatches("{")).toThrow(/not JSON/)
  })
})

describe("applyPatches", () => {
  it("applies RFC 6902 operations in order without changing the original", () => {
    const original = doc()
    const patched = applyPatches(
      original,
      readPatches([
        {
          op: "replace",
          path: "/servers/0/url",
          value: "https://pay.example.com",
        },
        { op: "remove", path: "/paths/~1login" },
        {
          op: "replace",
          path: "/components/parameters/XRequestedWith/required",
          value: false,
        },
        { op: "test", path: "/openapi", value: "3.0.3" },
        { op: "add", path: "/servers/-", value: { url: "https://b" } },
        { op: "add", path: "/servers/0", value: { url: "https://a" } },
        { op: "copy", from: "/paths/~1pets", path: "/paths/~1cats" },
        { op: "move", from: "/paths/~1cats", path: "/paths/~1dogs" },
      ]),
    ) as ReturnType<typeof doc> & { paths: Record<string, unknown> }

    expect(patched.servers.map((server) => server.url)).toEqual([
      "https://a",
      "https://pay.example.com",
      "https://b",
    ])
    expect(Object.keys(patched.paths)).toEqual(["/pets", "/dogs"])
    expect(patched.components.parameters.XRequestedWith.required).toBe(false)
    expect(original).toEqual(doc())
  })

  it("says which edit did not apply and why", () => {
    expect(() =>
      applyPatches(doc(), readPatches([{ op: "remove", path: "/nope/x" }])),
    ).toThrow(/Edit 1 \(remove \/nope\/x\): there is nothing at \/nope/)
    expect(() =>
      applyPatches(
        doc(),
        readPatches([
          { op: "remove", path: "/paths/~1login" },
          { op: "test", path: "/openapi", value: "3.1.0" },
        ]),
      ),
    ).toThrow(/Edit 2 \(test \/openapi\): .*not the one the test expects/)
    expect(() =>
      applyPatches(
        doc(),
        readPatches([{ op: "add", path: "/servers/5", value: 1 }]),
      ),
    ).toThrow(/not a position in the list/)
    expect(() =>
      applyPatches(
        doc(),
        readPatches([{ op: "move", from: "/paths", path: "/paths/x" }]),
      ),
    ).toThrow(/into itself/)
  })

  it("sets keys as own properties, so constructor and prototype are plain keys", () => {
    const patched = applyPatches(
      doc(),
      readPatches([
        { op: "add", path: "/constructor", value: { polluted: true } },
        { op: "add", path: "/info", value: { prototype: 1 } },
      ]),
    ) as Record<string, unknown>

    expect(Object.hasOwn(patched, "constructor")).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("edits one place of a YAML alias, not every place it was used", () => {
    const parsed = parseSpecText(`openapi: 3.0.3
paths:
  /a:
    get: &op
      summary: shared
  /b:
    get: *op
`)
    const patched = applyPatches(
      parsed,
      readPatches([
        { op: "replace", path: "/paths/~1a/get/summary", value: "mine" },
      ]),
    )

    expect(valueAt(patched, "/paths/~1a/get/summary")).toBe("mine")
    expect(valueAt(patched, "/paths/~1b/get/summary")).toBe("shared")
  })

  it("stops copying a large part over and over at the node limit", () => {
    const big = { openapi: "3.0.3", paths: {}, blob: Array(1000).fill(0) }
    const copies = Array.from({ length: 20 }, (_, i) => ({
      op: "copy",
      from: "/blob",
      path: `/blob${i}`,
    }))
    const nested = [
      { op: "add", path: "/x", value: [] },
      ...Array.from({ length: 25 }, () => ({
        op: "copy",
        from: "/x",
        path: "/x/-",
      })),
    ]

    expect(() => applyPatches(big, readPatches(copies))).not.toThrow()
    // Each copy doubles /x: 2^25 nodes is past the limit long before then.
    expect(2 ** 25).toBeGreaterThan(MAX_SPEC_NODES)
    expect(() => applyPatches(big, readPatches(nested))).toThrow(/too large/)
  })
})

describe("valueAt", () => {
  it("finds a value by pointer and answers undefined when there is none", () => {
    expect(valueAt(doc(), "/servers/0/url")).toBe("https://demo.example.com")
    expect(valueAt(doc(), "/servers/1")).toBeUndefined()
    expect(valueAt(doc(), "/paths/~1pets/nope")).toBeUndefined()
  })
})
