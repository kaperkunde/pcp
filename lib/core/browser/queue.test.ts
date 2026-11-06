import { describe, expect, it } from "vitest"

import {
  bounded,
  expectedWait,
  inLane,
  LaneBusy,
  LaneGaveUp,
  newLane,
  pause,
} from "./queue"

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

describe("a lane that has too much waiting", () => {
  const quick = {
    deadlineMs: 5_000,
    onDeadline: async (): Promise<never> => {
      throw new Error("late")
    },
  }

  it("refuses a call at once, with when to try again, rather than queue it behind more than it would wait", async () => {
    const lane = newLane()
    const held = inLane(lane, () => pause(300).then(() => "first"), quick)

    // Nothing known of the lane's turns yet: a turn counts turnMs.
    const refused = inLane(lane, async () => "second", {
      ...quick,
      maxWaitMs: 100,
      turnMs: 1_000,
    })
    await expect(refused).rejects.toBeInstanceOf(LaneBusy)
    await refused.catch((error: LaneBusy) => {
      expect(error.retryAfterMs).toBeGreaterThan(100)
      expect(error.ahead).toBe(1)
    })

    // One that would wait long enough queues as before.
    expect(
      await inLane(lane, async () => "third", {
        ...quick,
        maxWaitMs: 5_000,
        turnMs: 1_000,
      }),
    ).toBe("third")
    expect(await held).toBe("first")
  })

  it("refuses a call behind more than maxQueue others, however long they take", async () => {
    const lane = newLane()
    const calls = [0, 1, 2].map((n) =>
      inLane(lane, () => pause(30).then(() => n), quick),
    )

    await expect(
      inLane(lane, async () => 3, { ...quick, maxQueue: 2, turnMs: 1 }),
    ).rejects.toBeInstanceOf(LaneBusy)
    expect(await Promise.all(calls)).toEqual([0, 1, 2])
    // Once they are done, it is let in.
    expect(await inLane(lane, async () => 4, { ...quick, maxQueue: 2 })).toBe(4)
  })

  it("reckons the wait from the turns it took lately", async () => {
    const lane = newLane()
    expect(expectedWait(lane, 2_000)).toBe(0)

    await inLane(lane, () => pause(60), quick)
    expect(lane.averageMs).toBeGreaterThanOrEqual(50)
    expect(lane.queued).toBe(0)

    const now = 1_000_000
    expect(
      expectedWait(
        { queued: 3, runningSince: now - 20, averageMs: 100 },
        2_000,
        now,
      ),
    ).toBe(80 + 2 * 100)
  })
})

describe("a call with a time limit of its own", () => {
  const quick = {
    deadlineMs: 5_000,
    onDeadline: async (): Promise<never> => {
      throw new Error("late")
    },
  }

  it("leaves the queue when its time runs out, and the turn passes on", async () => {
    const lane = newLane()
    const order: string[] = []
    const first = inLane(
      lane,
      async () => {
        await pause(150)
        order.push("first")
      },
      quick,
    )
    const time = new AbortController()
    const left = inLane(
      lane,
      async () => {
        order.push("never")
      },
      { ...quick, giveUp: time.signal },
    )
    const last = inLane(
      lane,
      async () => {
        order.push("last")
      },
      quick,
    )

    time.abort()
    await expect(left).rejects.toBeInstanceOf(LaneGaveUp)
    await Promise.all([first, last])
    expect(order).toEqual(["first", "last"])
  })

  it("keeps its turn to the end once it runs: the next call waits for it", async () => {
    const lane = newLane()
    const order: string[] = []
    const time = new AbortController()
    const running = inLane(
      lane,
      async () => {
        await pause(100)
        order.push("running")
        return "done"
      },
      { ...quick, giveUp: time.signal },
    )
    await pause(10)
    time.abort()
    const next = inLane(
      lane,
      async () => {
        order.push("next")
      },
      quick,
    )

    expect(await running).toBe("done")
    await next
    expect(order).toEqual(["running", "next"])
  })

  it("is refused at once when its time ran out before it came", async () => {
    const time = new AbortController()
    time.abort()
    await expect(
      inLane(newLane(), async () => "x", { ...quick, giveUp: time.signal }),
    ).rejects.toBeInstanceOf(LaneGaveUp)
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
