import { describe, expect, it } from "vitest"

import {
  findPlaceholders,
  matchGrant,
  parseSecretPlaceholder,
  placeValues,
  scrubResult,
  type SecretGrant,
} from "./placeholders"

// A wrapper's secret placeholders, without a database: where they are found,
// which binding each needs, and what an answer looks like once scrubbed.

const GRANT: SecretGrant = [
  {
    pointer: "/auth/key",
    name: "Key",
    secretId: "s1",
    template: "{{secret}}",
    url: "https://api.example.com",
  },
]

describe("finding placeholders", () => {
  it("finds each by its JSON Pointer, escaping keys", async () => {
    expect(
      findPlaceholders({
        auth: { key: { $secret: "Key" } },
        "a/b": [{ $secret: "Other" }],
        plain: "x",
      }),
    ).toEqual([
      { pointer: "/auth/key", name: "Key" },
      { pointer: "/a~1b/0", name: "Other" },
    ])
  })

  it("refuses an object that only looks like one", () => {
    expect(parseSecretPlaceholder({ $secret: "Key", extra: 1 })).toBeNull()
    expect(() => findPlaceholders({ a: { $secret: 1 } })).toThrow(
      /\{"\$secret": "<its name>"\}/,
    )
    expect(() => findPlaceholders({ a: { $secret: "Key", b: 2 } })).toThrow()
  })
})

describe("matching them to bindings", () => {
  it("needs a binding for the exact place and name", () => {
    expect(
      matchGrant([{ pointer: "/auth/key", name: "Key" }], GRANT, "api/call"),
    ).toEqual(GRANT)
    expect(() =>
      matchGrant([{ pointer: "/q", name: "Key" }], GRANT, "api/call"),
    ).toThrow(/has not allowed the secret "Key" in api\/call at \/q/)
    expect(() =>
      matchGrant([{ pointer: "/auth/key", name: "Else" }], GRANT, "api/call"),
    ).toThrow()
    expect(() =>
      matchGrant([{ pointer: "/auth/key", name: "Key" }], undefined, "x"),
    ).toThrow()
  })

  it("puts values in only where they were found", () => {
    expect(
      placeValues(
        { auth: { key: { $secret: "Key" } }, q: "x" },
        new Map([["/auth/key", "v"]]),
      ),
    ).toEqual({ auth: { key: "v" }, q: "x" })
  })
})

describe("scrubbing an answer", () => {
  it("takes the value out of text, structured content and resources", () => {
    const scrubbed = scrubResult(
      {
        content: [
          { type: "text", text: "key=hunter22 ok" },
          {
            type: "resource",
            resource: { uri: "x:/y", text: "hunter22" },
          },
        ],
        structuredContent: { echoed: "hunter22" },
      },
      ["hunter22"],
    )

    expect(JSON.stringify(scrubbed)).not.toContain("hunter22")
    expect(scrubbed.content[0]).toEqual({
      type: "text",
      text: "key=[redacted] ok",
    })
  })
})
