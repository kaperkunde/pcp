import { describe, expect, it } from "vitest"

import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  resourceLimits,
  useResourceConfig,
} from "../resources/state"
import { parseSpecText } from "./parse"

const doc = { openapi: "3.0.3", info: { title: "T", version: "1" }, paths: {} }

describe("parseSpecText", () => {
  it("reads the same document from JSON and from YAML", () => {
    const yaml = `openapi: 3.0.3
info:
  title: T
  version: "1"
paths: {}
`
    expect(parseSpecText(JSON.stringify(doc))).toEqual(parseSpecText(yaml))
  })

  it("accepts 3.1 and later 3.x versions", () => {
    expect(
      parseSpecText(JSON.stringify({ ...doc, openapi: "3.1.0" })),
    ).toMatchObject({
      openapi: "3.1.0",
    })
    expect(
      parseSpecText(JSON.stringify({ ...doc, openapi: "3.2.0" })),
    ).toMatchObject({
      openapi: "3.2.0",
    })
  })

  it("says what to do about Swagger 2 and about other documents", () => {
    expect(() => parseSpecText(JSON.stringify({ swagger: "2.0" }))).toThrow(
      /Swagger 2\.0/,
    )
    expect(() => parseSpecText(JSON.stringify({ hello: 1 }))).toThrow(
      /openapi: 3\.x/,
    )
    expect(() => parseSpecText("- just\n- a list")).toThrow(/not an OpenAPI/)
    expect(() => parseSpecText("   ")).toThrow(/empty/)
    expect(() => parseSpecText("{ not json")).toThrow(/could not be read/)
  })

  it("refuses a schema over the size limit", () => {
    useResourceConfig({ ...EMPTY_CONFIG, specMb: 1 })

    try {
      const big = `openapi: 3.0.0\ninfo: {}\npaths: {}\n# ${"x".repeat(resourceLimits().specBytes)}`
      expect(() => parseSpecText(big)).toThrow(/larger than 1 MB/)
    } finally {
      forgetResourceLimits()
    }
  })

  it("stops a YAML alias bomb instead of expanding it", () => {
    const lines = [
      'a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
    ]
    for (let i = 1; i < 12; i++) {
      const refs = Array(9)
        .fill(`*a${i - 1}`)
        .join(",")
      lines.push(`a${i}: &a${i} [${refs}]`)
    }
    const started = Date.now()
    expect(() =>
      parseSpecText(`openapi: 3.0.0\npaths: {}\nx:\n  ${lines.join("\n  ")}`),
    ).toThrow(/too large once its anchors/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("builds no dates or binary values from YAML tags: it refuses the tag", () => {
    for (const tagged of [
      "!!timestamp 2001-12-14",
      "!!binary R0lGODlhDAAMAIQAAP",
    ]) {
      expect(() =>
        parseSpecText(`openapi: 3.0.0\npaths: {}\nx-tagged: ${tagged}\n`),
      ).toThrow(/could not be read/)
    }
    // A date written plainly stays the text it is.
    expect(
      parseSpecText("openapi: 3.0.0\npaths: {}\nx-when: 2001-12-14\n")[
        "x-when"
      ],
    ).toBe("2001-12-14")
  })

  it("takes the last of a duplicate key, as JSON does", () => {
    // Checking for duplicates is quadratic in the number of keys, so it is
    // off; the later value wins, the same as JSON.parse.
    expect(
      parseSpecText("openapi: 3.0.0\nopenapi: 3.1.0\npaths: {}").openapi,
    ).toBe("3.1.0")
  })

  it("reads a schema with tens of thousands of keys in reasonable time", () => {
    const keys = Array.from({ length: 40_000 }, (_, i) => `  /p${i}: {}`).join(
      "\n",
    )
    const started = Date.now()
    const doc = parseSpecText(`openapi: 3.0.0\npaths:\n${keys}\n`)

    expect(Object.keys(doc.paths)).toHaveLength(40_000)
    // 18 seconds with the duplicate check on.
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("refuses aliases that expand to far more than the file", () => {
    // 80 aliases of one 50,000-element array: four million nodes once
    // expanded, past what a 16 MB schema may come to.
    useResourceConfig({ ...EMPTY_CONFIG, specMb: 16 })
    const items = Array(50_000).fill("1").join(", ")
    const copies = Array.from({ length: 80 }, () => "  - *a").join("\n")
    const text = `openapi: 3.0.0\npaths: {}\nx-big: &a [${items}]\nx-copies:\n${copies}\n`
    const started = Date.now()

    try {
      expect(() => parseSpecText(text)).toThrow(/too large once its anchors/)
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      forgetResourceLimits()
    }
  })

  it("still reads a schema that uses a few aliases sensibly", () => {
    const doc = parseSpecText(`openapi: 3.0.0
paths: {}
x-shared: &s { a: 1, b: [1, 2, 3] }
x-one: *s
x-two: *s
`)
    expect(doc["x-one"]).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it("keeps a __proto__ key as data", () => {
    const parsed = parseSpecText(
      '{"openapi":"3.0.0","paths":{},"x":{"__proto__":{"polluted":true}}}',
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(parsed.x)).toBe(Object.prototype)
  })
})
