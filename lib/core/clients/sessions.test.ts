import { describe, expect, it } from "vitest"

import {
  MAX_SESSIONS,
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
})
