import { describe, expect, it } from "vitest"

import { CHALLENGE_HEADER, isChallenge } from "./challenge"

describe("telling a site's check of its visitors", () => {
  it("reads Cloudflare's header, in either shape of headers", () => {
    expect(isChallenge(new Headers({ "cf-mitigated": "challenge" }))).toBe(true)
    expect(isChallenge(new Headers({ "CF-Mitigated": " Challenge " }))).toBe(
      true,
    )
    expect(isChallenge({ [CHALLENGE_HEADER]: "challenge" })).toBe(true)
    expect(isChallenge({ [CHALLENGE_HEADER]: ["challenge"] })).toBe(true)
  })

  it("is not fooled by the page's text or another value", () => {
    expect(isChallenge(new Headers({ "content-type": "text/html" }))).toBe(
      false,
    )
    expect(isChallenge({ [CHALLENGE_HEADER]: "block" })).toBe(false)
    expect(isChallenge({})).toBe(false)
  })
})
