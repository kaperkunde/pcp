import { describe, expect, it } from "vitest"

import { bounded, inLane, newLane, pause } from "./queue"

// The lanes the browser's calls wait in: one per tab, each turn bounded by
// a deadline, and a caller that gives up passes its turn on.

const never = () => new Promise<string>(() => {})

describe("a lane", () => {
  it("runs its calls one at a time, in order", async () => {
    const lane = newLane()
    const seen: string[] = []
    const step = (name: string, ms: number) =>
      inLane(
        lane,
        async () => {
          seen.push(`${name} starts`)
          await pause(ms)
          seen.push(`${name} ends`)
          return name
        },
        { deadlineMs: 1_000, onDeadline: async () => "late" },
      )

    expect(await Promise.all([step("a", 30), step("b", 1)])).toEqual(["a", "b"])
    expect(seen).toEqual(["a starts", "a ends", "b starts", "b ends"])
  })

  it("leaves another lane alone: one tab's slow call does not hold up another tab's", async () => {
    const slow = newLane()
    const quick = newLane()
    const started = Date.now()

    void inLane(slow, () => pause(500).then(() => "slow"), {
      deadlineMs: 5_000,
      onDeadline: async () => "late",
    })
    await inLane(quick, async () => "quick", {
      deadlineMs: 5_000,
      onDeadline: async () => "late",
    })

    expect(Date.now() - started).toBeLessThan(200)
  })

  it("answers a call past its deadline with onDeadline's answer, and goes on", async () => {
    const lane = newLane()
    const order: string[] = []

    const hung = inLane(lane, never, {
      deadlineMs: 50,
      onDeadline: async () => {
        order.push("reopened")
        return "This tab stopped responding."
      },
    })
    const next = inLane(
      lane,
      async () => {
        order.push("next")
        return "next"
      },
      { deadlineMs: 50, onDeadline: async () => "late" },
    )

    expect(await hung).toBe("This tab stopped responding.")
    expect(await next).toBe("next")
    // The next call waits for the reopening, which is still the turn.
    expect(order).toEqual(["reopened", "next"])
  })

  it("answers a caller that gives up at once, and passes its turn on", async () => {
    const lane = newLane()
    const running = new AbortController()

    const held = inLane(lane, never, {
      deadlineMs: 60_000,
      signal: running.signal,
      onDeadline: async () => "late",
    })
    const waiting = new AbortController()
    const queued = inLane(lane, async () => "never runs", {
      deadlineMs: 60_000,
      signal: waiting.signal,
      onDeadline: async () => "late",
    })
    const last = inLane(lane, async () => "last", {
      deadlineMs: 60_000,
      onDeadline: async () => "late",
    })

    waiting.abort(new Error("gave up waiting"))
    await expect(queued).rejects.toThrow("gave up waiting")

    const started = Date.now()
    running.abort(new Error("gave up"))
    await expect(held).rejects.toThrow("gave up")
    expect(await last).toBe("last")
    expect(Date.now() - started).toBeLessThan(200)
  })

  it("refuses a caller that had already given up, without queueing it", async () => {
    const lane = newLane()
    const gone = new AbortController()
    gone.abort(new Error("before"))

    expect(() =>
      inLane(lane, async () => "x", {
        deadlineMs: 50,
        signal: gone.signal,
        onDeadline: async () => "late",
      }),
    ).toThrow("before")
    expect(
      await inLane(lane, async () => "after", {
        deadlineMs: 50,
        onDeadline: async () => "late",
      }),
    ).toBe("after")
  })

  it("passes a call's own error on, and goes on", async () => {
    const lane = newLane()
    const failed = inLane(
      lane,
      async () => {
        throw new Error("broke")
      },
      { deadlineMs: 50, onDeadline: async () => "late" },
    )

    await expect(failed).rejects.toThrow("broke")
    expect(
      await inLane(lane, async () => "ok", {
        deadlineMs: 50,
        onDeadline: async () => "late",
      }),
    ).toBe("ok")
  })
})

describe("bounded", () => {
  it("rejects what takes too long, naming it", async () => {
    await expect(bounded(never(), 20, "page.content")).rejects.toThrow(
      "page.content: Timeout 20ms exceeded.",
    )
    expect(await bounded(Promise.resolve(1), 20, "x")).toBe(1)
  })
})
