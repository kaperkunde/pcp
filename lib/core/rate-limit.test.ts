/**
 * The rate limiter PCP's routes, actions and gateway use
 * (@kaperkunde/security), held to what PCP relies on: a source's tries given
 * back, the least recently used window dropped first, and an instance-wide
 * counter never dropped.
 */
import { afterEach, describe, expect, it } from "vitest"

import {
  checkRateLimit,
  rateLimitSize,
  refundRateLimit,
  resetRateLimits,
  type RateLimit,
} from "@kaperkunde/security"

afterEach(() => {
  resetRateLimits()
})

const LIMIT = { max: 3, windowMs: 60_000 }

function allowed(key: string, limit: RateLimit): boolean {
  return checkRateLimit(key, limit).allowed
}

describe("checkRateLimit", () => {
  it("allows up to the limit in a window, then refuses", () => {
    expect([1, 2, 3, 4].map(() => allowed("k", LIMIT))).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(allowed("other", LIMIT)).toBe(true)
  })

  it("takes back a count it is given back, never below none", () => {
    allowed("k", LIMIT)
    allowed("k", LIMIT)
    allowed("k", LIMIT)
    expect(allowed("k", LIMIT)).toBe(false)

    // A right password gives its try back: the next one is allowed.
    refundRateLimit("k")
    expect(allowed("k", LIMIT)).toBe(true)
    expect(allowed("k", LIMIT)).toBe(false)

    for (let i = 0; i < 10; i++) refundRateLimit("k")
    expect([1, 2, 3, 4].map(() => allowed("k", LIMIT))).toEqual([
      true,
      true,
      true,
      false,
    ])

    // Nothing to give back for a key never counted.
    refundRateLimit("never")
    expect(allowed("never", LIMIT)).toBe(true)
  })
})

describe("the store's size", () => {
  it("holds a bounded number of windows, dropping the least recently used", () => {
    const one = { max: 1, windowMs: 60_000 }

    allowed("first", one)
    for (let i = 0; i < 12_000; i++) allowed(`flood:${i}`, one)

    expect(rateLimitSize()).toBeLessThanOrEqual(10_000)
    // The oldest window is gone, so that source starts over.
    expect(allowed("first", one)).toBe(true)
    // A recent one is still counted.
    expect(allowed("flood:11999", one)).toBe(false)
  })

  it("keeps a window in use and never drops an instance-wide counter", () => {
    const one = { max: 1, windowMs: 60_000 }

    expect(allowed("password:*", one)).toBe(true)
    allowed("busy", one)
    for (let i = 0; i < 12_000; i++) {
      allowed(`flood:${i}`, one)
      allowed("busy", one)
    }

    expect(allowed("password:*", one)).toBe(false)
    expect(allowed("busy", one)).toBe(false)
  })
})
