import { describe, expect, it } from "vitest"

import { makeRedactor, redactSecrets } from "./redact"

const SECRET = "sk-live-0123456789"

describe("redactSecrets", () => {
  it("removes the value wherever it appears", () => {
    expect(redactSecrets(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe(
      "a [redacted] b [redacted]",
    )
  })

  it("removes the longer value first, so a header is not left around the key", () => {
    expect(
      redactSecrets(`auth: Bearer ${SECRET}`, [SECRET, `Bearer ${SECRET}`]),
    ).toBe("auth: [redacted]")
  })

  it("removes the forms a JSON encoder writes", () => {
    const slashes = "sk/live/ABCDEF"
    const html = "k&v<x>y-secret"
    const accents = "clé-secret-1"
    const quoted = 'pa"ss\\word-1'

    // PHP escapes "/".
    expect(redactSecrets(`{"h":"sk\\/live\\/ABCDEF"}`, [slashes])).toBe(
      '{"h":"[redacted]"}',
    )
    // Go escapes < > &.
    expect(
      redactSecrets(`{"h":"k\\u0026v\\u003cx\\u003ey-secret"}`, [html]),
    ).toBe('{"h":"[redacted]"}')
    // Python and PHP escape non-ASCII.
    expect(redactSecrets(`{"h":"cl\\u00e9-secret-1"}`, [accents])).toBe(
      '{"h":"[redacted]"}',
    )
    // Everyone escapes quotes and backslashes.
    expect(redactSecrets(JSON.stringify({ h: quoted }), [quoted])).toBe(
      '{"h":"[redacted]"}',
    )
  })

  it("leaves text without the value alone, and ignores very short values", () => {
    expect(redactSecrets("nothing here", [SECRET])).toBe("nothing here")
    expect(redactSecrets("a cat sat", ["a", "", "cat"])).toBe("a cat sat")
  })

  it("drops the start of a key a cut ended in the middle of", () => {
    expect(
      redactSecrets(`token: ${SECRET.slice(0, 10)}`, [SECRET], {
        truncated: true,
      }),
    ).toBe("token: [redacted]")
    expect(redactSecrets(`ends: ${SECRET.slice(0, 10)}`, [SECRET])).toBe(
      `ends: ${SECRET.slice(0, 10)}`,
    )
  })
})

describe("the walker over a parsed value", () => {
  const redactor = makeRedactor([SECRET])

  it("cleans strings and keys at every depth", () => {
    expect(
      redactor.value({
        [SECRET]: 1,
        a: [`x ${SECRET}`, { b: SECRET, n: 2, ok: true, nothing: null }],
      }),
    ).toEqual({
      "[redacted]": 1,
      a: ["x [redacted]", { b: "[redacted]", n: 2, ok: true, nothing: null }],
    })
  })

  it("catches what the JSON parser decoded from an escape", () => {
    const parsed = JSON.parse('{"h":"sk\\u002dlive\\u002d0123456789"}')
    expect(redactor.value(parsed)).toEqual({ h: "[redacted]" })
  })

  it("does not let a __proto__ key replace the prototype", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}')
    const clean = redactor.value(parsed) as Record<string, unknown>

    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(clean).toEqual({ a: 1 })
  })

  it("stops at a depth it will not walk", () => {
    let nested: unknown = SECRET
    for (let i = 0; i < 600; i++) nested = [nested]
    expect(() => redactor.value(nested)).not.toThrow()
  })
})
