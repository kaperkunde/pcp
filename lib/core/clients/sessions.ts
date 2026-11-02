/**
 * What PCP remembers of a conversation, for the few things it says once per
 * session: the reminder to call read_memory every, and the instructions'
 * key rules repeated for an app that does not show them (profiles.ts).
 *
 * /mcp is stateless: no request carries a session id, in either protocol
 * era. A session here is a token and the client it came from (its name, or
 * its profile without one), begun again by an initialize and forgotten
 * after SESSION_IDLE_MS without a request. Two conversations of one app on
 * one token at once share a session, and one picked up after a long pause
 * gets the reminder again: both are accepted. In memory only, bounded, and
 * nothing of a request's content: three flags and a time.
 */

/** How long a session lasts without a request. */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** How many sessions are kept; the least recently used goes first. */
export const MAX_SESSIONS = 2_000

type SessionState = {
  lastAt: number
  /** read_memory (or memory) every ran in it. */
  memoryRead: boolean
  /** The reminder to call read_memory every was given. */
  reminded: boolean
  /** The instructions' key rules were repeated in an answer. */
  mirrored: boolean
}

const sessions = new Map<string, SessionState>()

/** The key of a token's session with one client. */
export function sessionKey(tokenId: string, client: string): string {
  return `${tokenId}\n${client}`
}

function fresh(now: number): SessionState {
  return { lastAt: now, memoryRead: false, reminded: false, mirrored: false }
}

function keep(key: string, state: SessionState) {
  // Map keeps insertion order: setting again moves it to the end.
  sessions.delete(key)
  sessions.set(key, state)

  while (sessions.size > MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value as string)
  }
}

/** The session under a key, a new one when it was idle too long. */
function current(key: string, now: number): SessionState {
  const known = sessions.get(key)
  const state =
    known && now - known.lastAt <= SESSION_IDLE_MS ? known : fresh(now)

  state.lastAt = now
  keep(key, state)
  return state
}

/** An initialize: the client starts over, and so does its session. */
export function startSession(key: string, now = Date.now()): void {
  keep(key, fresh(now))
}

/** read_memory every ran: no reminder in this session any more. */
export function noteMemoryRead(key: string, now = Date.now()): void {
  current(key, now).memoryRead = true
}

/**
 * Whether to remind about read_memory every now: once per session, and
 * only while it has not run.
 */
export function takeMemoryReminder(key: string, now = Date.now()): boolean {
  const state = current(key, now)

  if (state.memoryRead || state.reminded) {
    return false
  }

  state.reminded = true
  return true
}

/** Whether the key rules are still to be repeated in this session. */
export function takeMirror(key: string, now = Date.now()): boolean {
  const state = current(key, now)

  if (state.mirrored) {
    return false
  }

  state.mirrored = true
  return true
}

/** The rules were repeated another way (read_memory every's answer). */
export function noteMirrored(key: string, now = Date.now()): void {
  current(key, now).mirrored = true
}
