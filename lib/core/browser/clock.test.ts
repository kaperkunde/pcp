import { describe, expect, it } from "vitest"

import { atStep, callClock, timeoutMessage } from "./clock"
import { pause } from "./queue"

// A browser call's own time limit: it counts from start(), rings once,
// notes the step the call is at, and a default one is lengthened once for
// a site's check while one the call gave is kept to.

describe("a call's clock", () => {
  it("counts only once started, and rings when the time is up", async () => {
    const clock = callClock(40, true)
    await pause(60)
    expect(clock.expired.aborted).toBe(false)

    clock.start()
    await clock.ended
    expect(clock.expired.aborted).toBe(true)
    expect(clock.left()).toBe(0)
  })

  it("lengthens a default limit once for a site's check, and keeps to one the call gave", async () => {
    const byDefault = callClock(30, false)
    byDefault.start()
    byDefault.allowCheck(60)
    byDefault.allowCheck(1_000)
    expect(byDefault.left()).toBeGreaterThan(60)
    expect(byDefault.left()).toBeLessThanOrEqual(90)

    const given = callClock(30, true)
    given.start()
    given.allowCheck(1_000)
    expect(given.left()).toBeLessThanOrEqual(30)
    await Promise.all([byDefault.ended, given.ended])
  })

  it("says the step it was at, and whether what was asked may have happened", () => {
    const clock = callClock(10_000, false)
    clock.tabId = "t1"
    atStep(clock, "waiting for its turn on tab t1")
    expect(timeoutMessage("browser/navigate", clock)).toBe(
      "browser/navigate did not finish within 10 seconds, so it was answered without waiting further, while waiting for its turn on tab t1. Nothing was done on the page. Give timeout_ms (up to 120,000) to wait longer.",
    )

    atStep(clock, "loading example.com in tab t1", true)
    atStep(clock, "reading tab t1 for the answer")
    expect(timeoutMessage("browser/navigate", clock)).toContain(
      "while reading tab t1 for the answer. What it was asked to do may or may not have happened, and finishes in tab t1 on its own: take a snapshot",
    )
    clock.stop()
  })
})
