/**
 * What PCP remembers of a conversation, for the few things it says once per
 * session: the reminder to call search with no arguments (or read_memory every), the instructions' key
 * rules repeated for an app that does not show them (profiles.ts), and the
 * owner's answers to the token's requests, each told once.
 *
 * /mcp is stateless: no request carries a session id, in either protocol
 * era. A session here is a token and the client it came from (its name, or
 * its profile without one), begun again by an initialize and forgotten
 * after SESSION_IDLE_MS without a request. Two conversations of one app on
 * one token at once share a session, and one picked up after a long pause
 * gets the reminder again: both are accepted. In memory only, bounded, and
 * nothing of a request's content: three flags, a time, and the ids of the
 * owner's answers told lately with when they were given.
 */

/** How long a session lasts without a request. */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** How many sessions are kept; the least recently used goes first. */
export const MAX_SESSIONS = 2_000

/**
 * How far before a look the next one starts: an answer given while a look
 * ran, written a moment after it read, is found by the next one (and one
 * already told is skipped by its id).
 */
export const ANSWERED_SLACK_MS = 60_000

/** The most told answers a session keeps the ids of. */
export const MAX_ANSWERED_TOLD = 500

type SessionState = {
  lastAt: number
  /** read_memory (or memory) every ran in it. */
  memoryRead: boolean
  /** The reminder to call search with no arguments (or read_memory every) was given. */
  reminded: boolean
  /** The instructions' key rules were repeated in an answer. */
  mirrored: boolean
  /**
   * Answers to the token's requests are looked for from this time on (ms);
   * null until the session first looks.
   */
  answeredSince: number | null
  /**
   * Answers told in this session (or that it read through
   * check_permission), by request id, with when the owner gave them, kept
   * while they are at or after answeredSince so a second look skips them.
   */
  answeredTold: Map<string, number>
}

const sessions = new Map<string, SessionState>()

/** The key of a token's session with one client. */
export function sessionKey(tokenId: string, client: string): string {
  return `${tokenId}\n${client}`
}

function fresh(now: number): SessionState {
  return {
    lastAt: now,
    memoryRead: false,
    reminded: false,
    mirrored: false,
    answeredSince: null,
    answeredTold: new Map(),
  }
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

/** search with no arguments (or read_memory every) ran: no reminder in this session any more. */
export function noteMemoryRead(key: string, now = Date.now()): void {
  current(key, now).memoryRead = true
}

/**
 * Whether to remind about search with no arguments (or read_memory every) now: once per session, and
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

/** The rules were repeated another way (search's standing rules, or read_memory every). */
export function noteMirrored(key: string, now = Date.now()): void {
  current(key, now).mirrored = true
}

/**
 * Where to look for answers to the token's requests from, and the ones
 * this session was told already. A session's first look starts `windowMs`
 * back, so a conversation begun after the owner answered still hears of it.
 */
export function answeredCursor(
  key: string,
  windowMs: number,
  now = Date.now(),
): { since: number; told: ReadonlySet<string> } {
  const state = current(key, now)
  state.answeredSince ??= now - windowMs

  return {
    since: state.answeredSince,
    told: new Set(state.answeredTold.keys()),
  }
}

/**
 * Answers the session has heard of (told in a note, or read through
 * check_permission): not told again. `at` is when the owner answered.
 */
export function noteAnswersTold(
  key: string,
  answers: { id: string; at: number }[],
  now = Date.now(),
): void {
  const state = current(key, now)

  for (const { id, at } of answers) {
    state.answeredTold.delete(id)
    state.answeredTold.set(id, at)
  }

  while (state.answeredTold.size > MAX_ANSWERED_TOLD) {
    state.answeredTold.delete(state.answeredTold.keys().next().value as string)
  }
}

/**
 * A look for answers ran at `now` and found `seen`, all told now: the next
 * look starts ANSWERED_SLACK_MS before this one, and the ids of answers
 * given before that are let go, since no look finds them again.
 */
export function lookedForAnswers(
  key: string,
  seen: { id: string; at: number }[],
  now = Date.now(),
): void {
  noteAnswersTold(key, seen, now)
  const state = current(key, now)
  state.answeredSince = Math.max(
    state.answeredSince ?? 0,
    now - ANSWERED_SLACK_MS,
  )

  for (const [id, at] of state.answeredTold) {
    if (at < state.answeredSince) {
      state.answeredTold.delete(id)
    }
  }
}
