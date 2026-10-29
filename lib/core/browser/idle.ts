import { PERMISSION_TTL_MS } from "../permission-rules"
import type { TabControl } from "./types"

/**
 * When the browser closes for having nothing to do (runtime.ts `touch`).
 * Anything happening (a tool call, the owner's input, the live view
 * watching) waits the timer again; when it runs out, the browser closes,
 * unless a tab is still held for a hand-over the owner has not answered,
 * which waits it again instead. Kept apart from Chromium so it can be
 * tested on its own.
 */

/** What of a tab the idle close looks at. */
export type IdleTab = {
  control: TabControl
  handoverSince: number | null
}

/**
 * A tab the owner holds for an assistant's hand_over, whose request can
 * still be answered: the browser stays open for it, however long the owner
 * takes, until the request expires.
 */
export function handoverWaiting(
  tabs: Iterable<IdleTab>,
  now = Date.now(),
): boolean {
  for (const tab of tabs) {
    if (
      tab.control === "owner" &&
      tab.handoverSince !== null &&
      now - tab.handoverSince <= PERMISSION_TTL_MS
    ) {
      return true
    }
  }

  return false
}

export type IdleClose = {
  /** How long to wait, read each time the timer starts (the owner's setting). */
  delayMs: () => number
  /** Whether something still holds the browser open when the wait is over. */
  holdsOpen: () => boolean
  close: () => void
}

/**
 * Starts the wait again: the earlier timer is dropped, and when this one
 * runs out the browser closes, or waits again while something holds it.
 * The timer never keeps the process alive.
 */
export function waitIdle(
  holder: { idleTimer: NodeJS.Timeout | null },
  idle: IdleClose,
): void {
  if (holder.idleTimer) {
    clearTimeout(holder.idleTimer)
  }

  holder.idleTimer = setTimeout(() => {
    holder.idleTimer = null

    if (idle.holdsOpen()) {
      waitIdle(holder, idle)
      return
    }

    idle.close()
  }, idle.delayMs()).unref()
}
