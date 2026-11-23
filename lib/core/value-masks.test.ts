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
