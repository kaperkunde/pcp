import { afterEach, describe, expect, it } from "vitest"

import { checkRateLimit, refundRateLimit, resetRateLimits } from "./rate-limit"

afterEach(() => {
  resetRateLimits()
})

const LIMIT = { max: 3, windowMs: 60_000 }

describe("checkRateLimit", () => {
  it("allows up to the limit in a window, then refuses", () => {
    expect([1, 2, 3, 4].map(() => checkRateLimit("k", LIMIT))).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(checkRateLimit("other", LIMIT)).toBe(true)
  })

  it("takes back a count it is given back, never below none", () => {
    checkRateLimit("k", LIMIT)
    checkRateLimit("k", LIMIT)
    checkRateLimit("k", LIMIT)
    expect(checkRateLimit("k", LIMIT)).toBe(false)

    // A right password gives its try back: the next one is allowed.
    refundRateLimit("k")
    expect(checkRateLimit("k", LIMIT)).toBe(true)
    expect(checkRateLimit("k", LIMIT)).toBe(false)

    for (let i = 0; i < 10; i++) refundRateLimit("k")
    expect([1, 2, 3, 4].map(() => checkRateLimit("k", LIMIT))).toEqual([
      true,
      true,
      true,
      false,
    ])

    // Nothing to give back for a key never counted.
    refundRateLimit("never")
    expect(checkRateLimit("never", LIMIT)).toBe(true)
  })
})
