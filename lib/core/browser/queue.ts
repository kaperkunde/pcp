/**
 * How the browser's work waits its turn. Each tab has a lane of its own, so
 * a slow page holds up only the calls on that tab; the browser as a whole
 * has one more, held briefly, for what changes the set of tabs (runtime.ts
 * withVault). Every turn has a deadline, so nothing a page does (an alert,
 * a script that never ends, a renderer that hangs) holds a lane for longer,
 * and a caller that gives up (its AbortSignal) stops waiting at once and
 * passes its turn on.
 *
 * Nothing here knows about pages: what happens at a deadline is the
 * caller's (`onDeadline`), which for a tab reopens its page.
 */

export type Lane = { tail: Promise<void> }

export function newLane(): Lane {
  return { tail: Promise.resolve() }
}

export type LaneOptions<T> = {
  /** How long the work may run once its turn has come. */
  deadlineMs: number
  /** The caller gave up: it is answered with the signal's reason at once. */
  signal?: AbortSignal
  /**
   * Runs, still in the turn, once the work has passed its deadline; its
   * answer is the caller's, and the next turn waits for it.
   */
  onDeadline: () => Promise<T>
}

/**
 * Runs `work` after everything queued on the lane before it, for at most
 * `deadlineMs`. Work that passes its deadline goes on alone (a page's
 * operation cannot be called back), and so does work whose caller aborted;
 * neither holds the lane any longer.
 */
export function inLane<T>(
  lane: Lane,
  work: () => Promise<T>,
  { deadlineMs, signal, onDeadline }: LaneOptions<T>,
): Promise<T> {
  signal?.throwIfAborted()

  const previous = lane.tail
  let release!: () => void
  lane.tail = new Promise<void>((resolve) => {
    release = resolve
  })

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let started = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      settle()
    }
    const onAbort = () => {
      finish(() => reject(signal!.reason))
      // Waiting, its turn passes on once the one before it is done; running,
      // it passes on now.
      if (started) release()
      else void previous.then(release)
    }

    signal?.addEventListener("abort", onAbort, { once: true })

    void previous.then(async () => {
      if (settled) return

      started = true
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<"deadline">((done) => {
        timer = setTimeout(() => done("deadline"), deadlineMs)
      })
      const running = Promise.resolve()
        .then(work)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      const first = await Promise.race([running, deadline])
      clearTimeout(timer)

      if (first === "deadline") {
        try {
          const value = await onDeadline()
          finish(() => resolve(value))
        } catch (error) {
          finish(() => reject(error))
        } finally {
          release()
        }

        return
      }

      finish(() => (first.ok ? resolve(first.value) : reject(first.error)))
      release()
    })
  })
}

/**
 * A promise that rejects after `ms` instead of waiting on: for what
 * Playwright gives no timeout of its own (a page's content, its title, a
 * key press) and for DevTools calls.
 */
export function bounded<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}: Timeout ${ms}ms exceeded.`)),
        ms,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Waits `ms`, or until the signal aborts (then rejects with its reason). */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
