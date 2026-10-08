import { afterEach, describe, expect, it } from "vitest"

import {
  checkRateLimit,
  rateLimitSize,
  refundRateLimit,
  resetRateLimits,
} from "./rate-limit"

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

describe("the store's size", () => {
  it("holds a bounded number of windows, dropping the least recently used", () => {
    const one = { max: 1, windowMs: 60_000 }

    checkRateLimit("first", one)
    for (let i = 0; i < 12_000; i++) checkRateLimit(`flood:${i}`, one)

    expect(rateLimitSize()).toBeLessThanOrEqual(10_000)
    // The oldest window is gone, so that source starts over.
    expect(checkRateLimit("first", one)).toBe(true)
    // A recent one is still counted.
    expect(checkRateLimit("flood:11999", one)).toBe(false)
  })

  it("keeps a window in use and never drops an instance-wide counter", () => {
    const one = { max: 1, windowMs: 60_000 }

    expect(checkRateLimit("password:*", one)).toBe(true)
    checkRateLimit("busy", one)
    for (let i = 0; i < 12_000; i++) {
      checkRateLimit(`flood:${i}`, one)
      checkRateLimit("busy", one)
    }

    expect(checkRateLimit("password:*", one)).toBe(false)
    expect(checkRateLimit("busy", one)).toBe(false)
  })
})
