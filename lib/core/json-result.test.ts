import { describe, expect, it } from "vitest"

import { errorToolResult, jsonToolResult } from "./json-result"

describe("jsonToolResult", () => {
  it("answers with the JSON as text and as structured content", () => {
    expect(jsonToolResult({ ok: true })).toEqual({
      content: [{ type: "text", text: '{\n  "ok": true\n}' }],
      structuredContent: { ok: true },
    })
    expect(jsonToolResult([1, 2]).structuredContent).toEqual({ value: [1, 2] })
  })

  it("keeps a credential out of both", () => {
    const result = jsonToolResult(
      { echoed: "Basic c2VjcmV0LXZhbHVl", note: "key secret-value" },
      { redact: ["secret-value", "c2VjcmV0LXZhbHVl"] },
    )

    expect(JSON.stringify(result)).not.toContain("secret-value")
    expect(JSON.stringify(result)).not.toContain("c2VjcmV0LXZhbHVl")
  })

  it("leaves structured content out when it is too big", () => {
    expect(
      jsonToolResult({ big: "x".repeat(70_000) }).structuredContent,
    ).toBeUndefined()
  })
})

describe("errorToolResult", () => {
  it("is an error, with the credential removed", () => {
    expect(
      errorToolResult("no luck with hunter22", { redact: ["hunter22"] }),
    ).toEqual({
      content: [{ type: "text", text: "no luck with [redacted]" }],
      isError: true,
    })
  })
})
