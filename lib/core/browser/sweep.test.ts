import { describe, expect, it } from "vitest"

import { RUN_TAB_GRACE_MS, TAB_IDLE_TTL_MS } from "./limits"
import {
  callRun,
  runName,
  spanWords,
  tabsToSweep,
  type SweepTab,
} from "./sweep"

// Which tabs the browser closes at its next call: one nobody used for the
// TTL, and one whose run has ended (after a grace, or at once when a tab is
// wanted and the browser is full); never one in use, the owner's, or the
// one the call names.

const NOW = 10_000_000

function tab(id: string, more: Partial<SweepTab> = {}): SweepTab {
  return {
    id,
    tokenId: "token",
    control: "assistant",
    running: null,
    reopening: null,
    lastUsedAt: NOW,
    run: null,
    ...more,
  }
}

describe("the sweep of the browser's tabs", () => {
  it("closes a tab idle past the TTL, and keeps one used since", () => {
    expect(
      tabsToSweep(
        [
          tab("old", { lastUsedAt: NOW - TAB_IDLE_TTL_MS }),
          tab("fresh", { lastUsedAt: NOW - TAB_IDLE_TTL_MS + 1_000 }),
        ],
        { now: NOW },
      ),
    ).toEqual([{ id: "old", why: "idle" }])
  })

  it("closes a tab whose run has ended once the grace is over, or at once when room is needed", () => {
    const ended = { id: "r1", label: null, endedAt: NOW - 1_000 }
    const running = { id: "r2", label: null, endedAt: null }
    const tabs = [
      tab("done", { run: ended, lastUsedAt: NOW - 2_000 }),
      tab("going", { run: running, lastUsedAt: NOW - 2_000 }),
    ]

    expect(tabsToSweep(tabs, { now: NOW })).toEqual([])
    expect(tabsToSweep(tabs, { now: NOW + RUN_TAB_GRACE_MS })).toEqual([
      { id: "done", why: "run" },
    ])
    expect(tabsToSweep(tabs, { now: NOW, needRoom: true })).toEqual([
      { id: "done", why: "run" },
    ])
  })

  it("leaves a tab in use, being reopened, held by the owner, the owner's own, and the one the call names", () => {
    const old = { lastUsedAt: NOW - TAB_IDLE_TTL_MS * 2 }

    expect(
      tabsToSweep(
        [
          tab("busy", { ...old, running: { runId: null } }),
          tab("reopening", { ...old, reopening: Promise.resolve() }),
          tab("held", { ...old, control: "owner" }),
          tab("owners", { ...old, tokenId: null }),
          tab("named", old),
        ],
        { now: NOW, keep: "named" },
      ),
    ).toEqual([])
  })
})

describe("a call's run, as tabs keep it", () => {
  it("is none outside a run, and ends when the run's signal aborts", () => {
    expect(callRun(undefined, undefined)).toBeNull()
    expect(callRun("r1", undefined)).toBeNull()

    const run = new AbortController()
    const kept = callRun("r1", run.signal, () => 42)!
    expect(kept).toMatchObject({ id: "r1", endedAt: null })
    // The same run is one record, whichever tab it uses.
    expect(callRun("r1", run.signal)).toBe(kept)

    run.abort()
    expect(kept.endedAt).toBe(42)
  })

  it("is named for the list of tabs", () => {
    expect(runName({ id: "r1", label: null })).toBe("run r1")
    expect(runName({ id: "r1", label: "run_code" })).toBe("run_code run r1")
    expect(runName({ id: "r1", label: "shop/order" })).toBe(
      "run r1 (wrapper shop/order)",
    )
    expect(spanWords(40_000)).toBe("40 seconds")
    expect(spanWords(3 * 60_000)).toBe("3 minutes")
    expect(spanWords(5 * 3_600_000)).toBe("5 hours")
  })
})
