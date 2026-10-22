import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PACING_MAX_WAIT_MS, type PacingPolicy } from "./limits"
import {
  jitterFor,
  pacedMessage,
  resetPacing,
  setPacingClock,
  waitForSlot,
} from "./pace"

// The pacing itself, on fake timers: the pause and its random extra wait,
// callers given distinct slots in the order they ask, the burst cap, the
// longest wait served and the answer past it, and a caller that gives up.

const PAUSE: PacingPolicy = { minIntervalMs: 1_000, jitterMs: 0, burst: null }

/** When each of the calls went ahead, in fake milliseconds from the start. */
let start = 0

function elapsed(): number {
  return Date.now() - start
}

beforeEach(() => {
  vi.useFakeTimers()
  start = Date.now()
  resetPacing()
  setPacingClock(null)
})

afterEach(() => {
  vi.useRealTimers()
  setPacingClock(null)
  resetPacing()
})

describe("jitterFor", () => {
  it("stays between none and the most the policy allows", () => {
    expect(jitterFor(0, () => 0.99)).toBe(0)
    expect(jitterFor(2_500, () => 0)).toBe(0)
    expect(jitterFor(2_500, () => 0.999_999)).toBe(2_500)

    for (let i = 0; i < 1_000; i++) {
      const value = jitterFor(2_500, Math.random)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(2_500)
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it("adds a random wait on top of the pause, never less than the pause", async () => {
    const policy: PacingPolicy = {
      minIntervalMs: 1_500,
      jitterMs: 2_500,
      burst: null,
    }
    const gaps: number[] = []
    let last = 0

    for (let i = 0; i < 20; i++) {
      const going = waitForSlot("v\nsite:a.test", "a.test", policy)
      await vi.runAllTimersAsync()
      expect(await going).toBeNull()
      if (i > 0) gaps.push(elapsed() - last)
      last = elapsed()
    }

    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1_500)
      expect(gap).toBeLessThanOrEqual(4_000)
    }
    // Not a fixed interval.
    expect(new Set(gaps).size).toBeGreaterThan(1)
  })
})

describe("waitForSlot", () => {
  it("lets the first action go at once, and the next after the pause", async () => {
    expect(await waitForSlot("v\nserver:s", "Things", PAUSE)).toBeNull()
    expect(elapsed()).toBe(0)

    const second = waitForSlot("v\nserver:s", "Things", PAUSE)
    await vi.advanceTimersByTimeAsync(999)
    let done = false
    void second.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await second).toBeNull()
  })

  it("gives callers who ask at once distinct slots, in the order they asked", async () => {
    const order: Array<{ name: string; at: number }> = []
    const ask = (name: string) =>
      waitForSlot("v\nsite:b.test", "b.test", PAUSE).then(() =>
        order.push({ name, at: elapsed() }),
      )

    const all = Promise.all([ask("first"), ask("second"), ask("third")])
    await vi.runAllTimersAsync()
    await all

    expect(order).toEqual([
      { name: "first", at: 0 },
      { name: "second", at: 1_000 },
      { name: "third", at: 2_000 },
    ])
  })

  it("keeps destinations, and vaults, apart", async () => {
    await waitForSlot("v\nsite:c.test", "c.test", PAUSE)
    await waitForSlot("v\nsite:d.test", "d.test", PAUSE)
    await waitForSlot("w\nsite:c.test", "c.test", PAUSE)
    expect(elapsed()).toBe(0)
  })

  it("holds a burst to its cap, and lets the next go when the oldest leaves the window", async () => {
    const policy: PacingPolicy = {
      minIntervalMs: 0,
      jitterMs: 0,
      burst: { max: 3, perMs: 10_000 },
    }

    for (let i = 0; i < 3; i++) {
      expect(await waitForSlot("v\nserver:b", "Things", policy)).toBeNull()
    }
    expect(elapsed()).toBe(0)

    await vi.advanceTimersByTimeAsync(4_000)
    const fourth = waitForSlot("v\nserver:b", "Things", policy)
    await vi.runAllTimersAsync()
    expect(await fourth).toBeNull()
    expect(elapsed()).toBe(10_000)
  })

  it("answers when the next action goes, rather than wait past the longest wait", async () => {
    const policy: PacingPolicy = {
      minIntervalMs: PACING_MAX_WAIT_MS + 15_000,
      jitterMs: 0,
      burst: null,
    }

    expect(await waitForSlot("v\nserver:x", "Things", policy)).toBeNull()
    const answer = await waitForSlot("v\nserver:x", "Things", policy)
    expect(answer).toBe(
      "Paced: Things takes its next action in 45 s; try again then.",
    )
    expect(elapsed()).toBe(0)

    // The refused call took no slot: the one after waits no longer.
    await vi.advanceTimersByTimeAsync(20_000)
    const later = waitForSlot("v\nserver:x", "Things", policy)
    await vi.runAllTimersAsync()
    expect(await later).toBeNull()
    expect(elapsed()).toBe(PACING_MAX_WAIT_MS + 15_000)
  })

  it("serves a wait up to the longest one", async () => {
    const policy: PacingPolicy = {
      minIntervalMs: PACING_MAX_WAIT_MS,
      jitterMs: 0,
      burst: null,
    }

    await waitForSlot("v\nserver:y", "Things", policy)
    const second = waitForSlot("v\nserver:y", "Things", policy)
    await vi.runAllTimersAsync()
    expect(await second).toBeNull()
    expect(elapsed()).toBe(PACING_MAX_WAIT_MS)
  })

  it("stops waiting when the caller gives up, and gives its slot back", async () => {
    await waitForSlot("v\nsite:e.test", "e.test", PAUSE)
    const controller = new AbortController()
    const waiting = waitForSlot("v\nsite:e.test", "e.test", PAUSE, {
      signal: controller.signal,
    })
    const caught = waiting.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(300)
    controller.abort(new Error("The run stopped."))
    expect(await caught).toEqual(new Error("The run stopped."))

    // The next caller takes the slot the one who left gave back.
    const next = waitForSlot("v\nsite:e.test", "e.test", PAUSE)
    await vi.runAllTimersAsync()
    await next
    expect(elapsed()).toBe(1_000)
  })

  it("refuses at once a caller that gave up already", async () => {
    const controller = new AbortController()
    controller.abort(new Error("gone"))
    await expect(
      waitForSlot("v\nsite:f.test", "f.test", PAUSE, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("gone")
  })
})

describe("pacedMessage", () => {
  it("rounds up to whole seconds, at least one", () => {
    expect(pacedMessage("a.test", 200)).toBe(
      "Paced: a.test takes its next action in 1 s; try again then.",
    )
    expect(pacedMessage("a.test", 31_001)).toContain("in 32 s")
  })
})
