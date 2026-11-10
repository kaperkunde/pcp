/**
 * The duplicate guard's bounds (guard.ts): how long a Write or Destructive
 * call is remembered, so the same call made again is answered with how the
 * first one went instead of running twice.
 */

/** How long a call is remembered, unless the owner set a tool's own. */
export const DUPLICATE_CALL_MS = 30 * 60_000

/** The window in words, for descriptions and answers alike. */
export const DUPLICATE_WINDOW_WORDS = `a while (${DUPLICATE_CALL_MS / 60_000} minutes unless the owner set otherwise)`

/** What the owner may set a tool's window to, in minutes. */
export const DUPLICATE_WINDOW_MINUTES = { min: 1, max: 24 * 60 } as const

/**
 * How long a call record is kept at all: the longest window the owner may
 * set. The cleanup removes older ones.
 */
export const CALL_RECORD_KEEP_MS = DUPLICATE_WINDOW_MINUTES.max * 60_000

/**
 * A call still marked running after this long never reported back (PCP
 * stopped under it): it reads as one that may have happened.
 */
export const STALE_RUNNING_MS = 15 * 60_000

/** Tools with a window of their own (or none) at most, in the setting. */
export const MAX_GUARD_OVERRIDES = 500

/**
 * The longest answer kept with a call's record, encrypted, to hand back
 * with a repeat; a longer one is named by the kept result it already was.
 */
export const MAX_INLINE_ANSWER_CHARS = 4_000

/** The longest reason an assistant gives for repeating a call. */
export const MAX_RERUN_REASON_CHARS = 300

/**
 * Kinds of server whose calls are never guarded: the browser (a page is
 * driven step by step, and a click or a key repeats on purpose), SSH's
 * run_command (a command run again is the usual way to look again) and
 * stores (a file saved, moved or deleted twice fails or does the same).
 */
export const UNGUARDED_KINDS: ReadonlySet<string> = new Set([
  "browser",
  "ssh",
  "storage",
])
