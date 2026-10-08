import { describe, expect, it } from "vitest"

import { returnPath } from "./return-path"

describe("returnPath", () => {
  it("goes on to the sign-in page for assistants, with its query", () => {
    expect(returnPath("/oauth/authorize?client_id=a&state=b")).toBe(
      "/oauth/authorize?client_id=a&state=b",
    )
  })

  it("goes nowhere else", () => {
    for (const value of [
      undefined,
      "",
      "/servers",
      "/oauth/authorize",
      "https://evil.example/oauth/authorize?x=1",
      "//evil.example/oauth/authorize?x=1",
      "/oauth/authorize/../../servers?x=1",
      "/oauth/authorizex?x=1",
      "/\\evil.example/oauth/authorize?x=1",
    ]) {
      expect(returnPath(value)).toBeNull()
    }
  })
})
