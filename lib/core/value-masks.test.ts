import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import { maskedValue, valueMasker } from "./value-masks"

// The masker the browser's typed secrets and pass-only kept values share:
// what stands in for a value found in JSON text leaves it valid JSON.

function masker(value: string) {
  return valueMasker([maskedValue("id1", value)], {
    render: (label) => `[kept: ${label}]`,
    minNormalChars: 8,
  })!
}

describe("a value found right after a JSON escape", () => {
  it("takes the escape's backslash with it", () => {
    // \n, then the value: normalised, the backslash is a separator, so the
    // run would start at the n.
    const text = JSON.stringify({ a: "x\ntok8f3KdPq2ZxW91" })
    expect(text).toContain("\\ntok")

    const masked = masker("ntok8f3KdPq2ZxW91")(text)

    expect(masked).not.toContain("\\[kept")
    expect(JSON.parse(masked)).toEqual({ a: "x[kept: id1]" })
  })

  it("takes a \\u escape it starts inside of, at either end", () => {
    const start = '{"a":"\\u00e9abcdefgh1234"}'
    const atStart = masker("00e9abcdefgh1234")(start)
    expect(JSON.parse(atStart)).toEqual({ a: "[kept: id1]" })

    const end = '{"a":"abcdefgh1234\\u00e9 and more"}'
    const atEnd = masker("abcdefgh1234u0")(end)
    expect(JSON.parse(atEnd)).toEqual({ a: "[kept: id1] and more" })
  })

  it("leaves a whole escape before the value alone, and an escaped backslash", () => {
    const text = JSON.stringify({ a: "line\n tok8f3KdPq2ZxW91", b: "c:\\\\" })
    const masked = masker("tok8f3KdPq2ZxW91")(text)

    expect(JSON.parse(masked)).toEqual({
      a: "line\n [kept: id1]",
      b: "c:\\\\",
    })

    const after = '{"a":"\\\\tok8f3KdPq2ZxW91"}'
    expect(JSON.parse(masker("tok8f3KdPq2ZxW91")(after))).toEqual({
      a: "\\[kept: id1]",
    })
  })
})

describe("the pass over a text, with as many values as a token can hold", () => {
  // 300 results, each in two forms: 600 values of 600 lengths up to 16K.
  const lengths = Array.from(
    { length: 600 },
    (_, index) => 8 + Math.floor((index * 16_376) / 599),
  )
  const options = {
    render: (label: string) => `[kept: ${label}]`,
    minNormalChars: 8,
    repeating: "words" as const,
  }

  function timed(values: ReturnType<typeof maskedValue>[], text: string) {
    const masker = valueMasker(values, options)!
    const started = performance.now()
    const masked = masker(text)
    return { masked, ms: performance.now() - started }
  }

  it("stays one pass when the values share a stretch the text repeats", () => {
    const values = lengths.map((length, index) =>
      maskedValue(
        `r${index}`,
        `QWERTY${randomBytes(length)
          .toString("hex")
          .slice(0, length - 6)}`,
      ),
    )
    // Was about 2 s for this before the values were anchored.
    expect(timed(values, "QWERTY".repeat(16_667)).ms).toBeLessThan(1_000)
  })

  it("leaves a value that repeats itself to whole words, so a text of it costs a pass", () => {
    const values = lengths.map((length, index) =>
      maskedValue(`r${index}`, "A".repeat(length)),
    )
    // Did not finish in two minutes before.
    const { masked, ms } = timed(values, "A".repeat(100_000))
    expect(ms).toBeLessThan(1_000)
    expect(masked).toBe("A".repeat(100_000))

    // As a whole word it is still found.
    expect(valueMasker(values, options)!(`x ${"A".repeat(8)} y`)).toBe(
      "x [kept: r0] y",
    )
  })

  it("still finds a value that does not repeat itself inside a longer word", () => {
    const value = "tok8f3KdPq2ZxW91mLr"
    const masker = valueMasker([maskedValue("r1", value)], options)!
    expect(masker(`prefix${value.toLowerCase()}suffix`)).toBe(
      "prefix[kept: r1]suffix",
    )
  })
})
