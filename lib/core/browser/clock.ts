import { MAX_CALL_TIMEOUT_MS } from "./limits"

/**
 * A browser call's own time limit (timeout_ms, or the default tabs open,
 * navigate and snapshot have): when it runs out, the call is answered at
 * once with a `timeout` tool error naming the step it was at and whether
 * what it was asked may have happened (call.ts). A call still waiting for
 * its tab's turn leaves the queue (`expired`, queue.ts giveUp) and did
 * nothing; one already running goes on alone in its turn, as a page's
 * operation cannot be called back, and the tab's next call waits for it.
 * Kept apart from Chromium so it can be tested on its own.
 */
export type CallClock = {
  /** The call's limit, in milliseconds. */
  readonly ms: number
  /** The call gave it (timeout_ms), rather than the tool's default. */
  readonly given: boolean
  /** What the call is doing now, in words: "loading example.com". */
  step: string
  /** What it was asked to do may have begun (a click, a page load). */
  acted: boolean
  /** The tab it acts on, or the one it opened. */
  tabId: string | null
  /** Aborts when the time is up. */
  readonly expired: AbortSignal
  /** Settles when the time is up. */
  readonly ended: Promise<void>
  /** Starts the time (once): before it, nothing counts. */
  start(): void
  /** Milliseconds left: all of them before start(). */
  left(): number
  /**
   * A site's check of its visitors is up: a default limit is lengthened
   * by `ms`, once, so it does not cut short a check that passes on its own.
   * A limit the call gave is kept to.
   */
  allowCheck(ms: number): void
  /** The call is done: the timer goes. */
  stop(): void
}

export function callClock(ms: number, given: boolean): CallClock {
  const controller = new AbortController()
  let ring!: () => void
  const ended = new Promise<void>((resolve) => {
    ring = resolve
  })
  let timer: NodeJS.Timeout | null = null
  let endsAt: number | null = null
  let lengthened = false

  const arm = (after: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      controller.abort("timeout")
      ring()
    }, after)
    timer.unref?.()
  }

  return {
    ms,
    given,
    step: "getting ready",
    acted: false,
    tabId: null,
    expired: controller.signal,
    ended,
    start() {
      if (endsAt !== null || controller.signal.aborted) return
      endsAt = Date.now() + ms
      arm(ms)
    },
    left() {
      return endsAt === null ? ms : Math.max(0, endsAt - Date.now())
    },
    allowCheck(extra: number) {
      if (given || lengthened || endsAt === null || controller.signal.aborted) {
        return
      }

      lengthened = true
      endsAt += extra
      arm(endsAt - Date.now())
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/** Sets what the call is doing now; `acted` marks that it may have begun. */
export function atStep(
  clock: CallClock | undefined,
  step: string,
  acted = false,
): void {
  if (!clock || clock.expired.aborted) return
  clock.step = step
  if (acted) clock.acted = true
}

function seconds(ms: number): string {
  const value = Math.round(ms / 100) / 10
  return `${value} ${value === 1 ? "second" : "seconds"}`
}

/** The `timeout` tool error's words. */
export function timeoutMessage(label: string, clock: CallClock): string {
  const tab = clock.tabId ? `tab ${clock.tabId}` : "the tab"
  const what = clock.acted
    ? `What it was asked to do may or may not have happened, and finishes in ${tab} on its own: take a snapshot to see the page before you try again.`
    : "Nothing was done on the page."
  const longer = clock.given
    ? ""
    : ` Give timeout_ms (up to ${MAX_CALL_TIMEOUT_MS.toLocaleString("en")}) to wait longer.`

  return `${label} did not finish within ${seconds(clock.ms)}, so it was answered without waiting further, while ${clock.step}. ${what}${longer}`
}
