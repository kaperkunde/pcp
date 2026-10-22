import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PERMISSION_TTL_MS } from "../permission-rules"
import { handoverWaiting, type IdleTab, waitIdle } from "./idle"

// The browser closes after the owner's idle minutes with nothing happening:
// anything that happens waits again, and a tab held for a hand-over the
// owner has not answered keeps it open until the request expires.

const MINUTE = 60_000

describe("the idle close", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function browser(delayMs = 60 * MINUTE) {
    const tabs: IdleTab[] = []
    const holder = { idleTimer: null as NodeJS.Timeout | null }
    const close = vi.fn()
    const touch = () =>
      waitIdle(holder, {
        delayMs: () => delayMs,
        holdsOpen: () => handoverWaiting(tabs, Date.now()),
        close,
      })

    return { tabs, holder, close, touch }
  }

  it("closes once the wait is over, and each touch waits again", () => {
    const { close, touch } = browser()

    touch()
    vi.advanceTimersByTime(59 * MINUTE)
    // A tool call, input, or the live view's tick.
    touch()
    vi.advanceTimersByTime(59 * MINUTE)
    expect(close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(MINUTE)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("waits as long as the owner's setting says", () => {
    const { close, touch } = browser(5 * MINUTE)

    touch()
    vi.advanceTimersByTime(5 * MINUTE)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("stays open while a hand-over waits for the owner", () => {
    const { tabs, close, touch } = browser()
    const tab: IdleTab = { control: "owner", handoverSince: Date.now() }
    tabs.push({ control: "assistant", handoverSince: null }, tab)

    touch()
    vi.advanceTimersByTime(5 * 60 * MINUTE)
    expect(close).not.toHaveBeenCalled()

    // The owner answers: the tab goes back, and the next wait closes it.
    tab.control = "assistant"
    tab.handoverSince = null
    vi.advanceTimersByTime(60 * MINUTE)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes once a hand-over nobody answered has expired", () => {
    const { tabs, close, touch } = browser()
    tabs.push({ control: "owner", handoverSince: Date.now() })

    touch()
    vi.advanceTimersByTime(PERMISSION_TTL_MS)
    expect(close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60 * MINUTE)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("does not count a tab the owner took over without a hand-over", () => {
    const { tabs, close, touch } = browser()
    tabs.push({ control: "owner", handoverSince: null })

    touch()
    vi.advanceTimersByTime(60 * MINUTE)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
