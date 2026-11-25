import { describe, expect, it } from "vitest"

import {
  ANSWERED_SLACK_MS,
  answeredCursor,
  lookedForAnswers,
  MAX_SESSIONS,
  noteAnswersTold,
  SESSION_IDLE_MS,
  noteMemoryRead,
  noteMirrored,
  sessionKey,
  startSession,
  takeMemoryReminder,
  takeMirror,
} from "./sessions"

let counter = 0
const key = () => sessionKey(`token-${++counter}`, "claude-ai")

describe("sessions", () => {
  it("remind once, and not once read_memory every ran", () => {
    const first = key()
    expect(takeMemoryReminder(first)).toBe(true)
    expect(takeMemoryReminder(first)).toBe(false)

    const second = key()
    noteMemoryRead(second)
    expect(takeMemoryReminder(second)).toBe(false)
  })

  it("repeat the rules once, or not after read_memory every had them", () => {
    const first = key()
    expect(takeMirror(first)).toBe(true)
    expect(takeMirror(first)).toBe(false)

    const second = key()
    noteMirrored(second)
    expect(takeMirror(second)).toBe(false)
  })

  it("start over on an initialize, and after a long pause", () => {
    const one = key()
    const now = Date.now()
    expect(takeMemoryReminder(one, now)).toBe(true)
    startSession(one, now + 1)
    expect(takeMemoryReminder(one, now + 2)).toBe(true)
    expect(takeMemoryReminder(one, now + 3)).toBe(false)
    expect(takeMemoryReminder(one, now + 3 + SESSION_IDLE_MS + 1)).toBe(true)
  })

  it("keep a session while requests keep coming", () => {
    const one = key()
    const now = Date.now()
    noteMemoryRead(one, now)
    expect(takeMemoryReminder(one, now + SESSION_IDLE_MS - 1)).toBe(false)
    expect(takeMemoryReminder(one, now + 2 * SESSION_IDLE_MS - 2)).toBe(false)
  })

  it("forget the least recently used past the bound", () => {
    const oldest = key()
    noteMemoryRead(oldest)

    for (let index = 0; index < MAX_SESSIONS; index++) {
      takeMirror(key())
    }

    // Forgotten: a new session, which reminds again.
    expect(takeMemoryReminder(oldest)).toBe(true)
  })

  it("look for the owner's answers from a window back, and skip those told (#59)", () => {
    const one = key()
    const now = Date.now()
    const hour = 60 * 60_000

    // The first look reaches back the window it is given.
    expect(answeredCursor(one, hour, now)).toEqual({
      since: now - hour,
      told: new Set(),
      running: new Set(),
    })

    // An answer given just before the look, and one long before: both told.
    lookedForAnswers(
      one,
      [
        { id: "recent", at: now - 1_000 },
        { id: "old", at: now - 30 * 60_000 },
      ],
      now,
    )

    // The next look starts a little before the last, and skips the one told
    // in that while; the old one is let go, since no look finds it again.
    const next = answeredCursor(one, hour, now + 5_000)
    expect(next.since).toBe(now - ANSWERED_SLACK_MS)
    expect(next.told).toEqual(new Set(["recent"]))

    // One read through check_permission is skipped too.
    noteAnswersTold(one, [{ id: "checked", at: now + 6_000 }], now + 6_000)
    expect(answeredCursor(one, hour, now + 7_000).told).toEqual(
      new Set(["recent", "checked"]),
    )

    // An initialize starts over: the window back again, nothing told.
    startSession(one, now + 8_000)
    expect(answeredCursor(one, hour, now + 9_000)).toEqual({
      since: now + 9_000 - hour,
      told: new Set(),
      running: new Set(),
    })
  })

  it("tell a request seen while it ran again once it finished, and hold the cursor back for it", () => {
    const one = key()
    const now = Date.now()
    const hour = 60 * 60_000
    const allowed = now - 10 * 60_000

    answeredCursor(one, hour, now)
    lookedForAnswers(
      one,
      [
        { id: "slow", at: allowed, running: true },
        { id: "quick", at: now - 1_000 },
      ],
      now,
    )

    // Still running: not told as done, and the next look reaches back to it.
    const during = answeredCursor(one, hour, now + 5 * 60_000)
    expect(during.since).toBe(allowed)
    expect(during.running).toEqual(new Set(["slow"]))
    expect(during.told).toEqual(new Set(["quick"]))
    lookedForAnswers(
      one,
      [{ id: "slow", at: allowed, running: true }],
      now + 5 * 60_000,
    )
    expect(answeredCursor(one, hour, now + 5 * 60_000).since).toBe(allowed)

    // A check_permission that still found it running is no more than that.
    noteAnswersTold(
      one,
      [{ id: "slow", at: allowed, running: true }],
      now + 6 * 60_000,
    )
    expect(answeredCursor(one, hour, now + 6 * 60_000).told).not.toContain(
      "slow",
    )

    // Told once it finished: skipped from then on, and the cursor moves on.
    lookedForAnswers(one, [{ id: "slow", at: allowed }], now + 10 * 60_000)
    const after = answeredCursor(one, hour, now + 10 * 60_000)
    expect(after.running).toEqual(new Set())
    // Given before the new cursor, no look finds it again: let go.
    expect(after.told.has("slow")).toBe(false)
    expect(after.since).toBe(now + 10 * 60_000 - ANSWERED_SLACK_MS)
  })
})
