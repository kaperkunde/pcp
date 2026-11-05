/**
 * How the browser's work waits its turn. Each tab has a lane of its own, so
 * a slow page holds up only the calls on that tab; the browser as a whole
 * has one more, held briefly, for what changes the set of tabs (runtime.ts
 * withVault). Every turn has a deadline, so nothing a page does (an alert,
 * a script that never ends, a renderer that hangs) holds a lane for longer,
 * and a caller that gives up (its AbortSignal) stops waiting at once and
 * passes its turn on.
 *
 * A lane also knows how much waits on it: a call that would wait longer
 * than it means to (`maxWaitMs`), or behind more than `maxQueue` others, is
 * refused at once with LaneBusy and when to try again, rather than queued
 * where it would only time out. And a caller with a time limit of its own
 * (`giveUp`) leaves the queue when it runs out, still waiting; once its
 * turn has come, the work keeps the turn until it ends or its deadline.
 *
 * Nothing here knows about pages: what happens at a deadline is the
 * caller's (`onDeadline`), which for a tab reopens its page.
 */

export type Lane = {
  tail: Promise<void>
  /** Calls on it not yet done: the one running and those waiting. */
  queued: number
  /** When the running turn began; null while none runs. */
  runningSince: number | null
  /** How long its turns took lately (a moving average); null before one. */
  averageMs: number | null
}

export function newLane(): Lane {
  return {
    tail: Promise.resolve(),
    queued: 0,
    runningSince: null,
    averageMs: null,
  }
}

/** A call refused rather than queued: the lane has too much waiting. */
export class LaneBusy extends Error {
  readonly retryAfterMs: number
  /** Calls ahead of it when it came. */
  readonly ahead: number

  constructor(retryAfterMs: number, ahead: number) {
    super("The lane has too much waiting.")
    this.name = "LaneBusy"
    this.retryAfterMs = retryAfterMs
    this.ahead = ahead
  }
}

/** A caller's own time ran out while it still waited for its turn. */
export class LaneGaveUp extends Error {
  constructor() {
    super("The call stopped waiting for its turn.")
    this.name = "LaneGaveUp"
  }
}

/**
 * How long a call that comes now may expect to wait for its turn: what is
 * left of the running turn, as long as turns took lately, and a whole turn
 * for each call waiting before it. `turnMs` stands for a lane with no
 * history yet.
 */
export function expectedWait(
  lane: Pick<Lane, "queued" | "runningSince" | "averageMs">,
  turnMs: number,
  now = Date.now(),
): number {
  if (lane.queued === 0) {
    return 0
  }

  const turn = lane.averageMs ?? turnMs
  const left =
    lane.runningSince === null
      ? turn
      : Math.max(0, turn - (now - lane.runningSince))

  return left + (lane.queued - 1) * turn
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
  /**
   * The caller's own time ran out: while it still waits, it leaves the
   * queue (rejected with LaneGaveUp) and its turn passes on; once its turn
   * has come, nothing changes here (the work keeps its turn to the end).
   */
  giveUp?: AbortSignal
  /**
   * Refuse the call (LaneBusy) when it can expect to wait longer than this
   * for its turn, or when more than `maxQueue` calls wait before it.
   */
  maxWaitMs?: number
  maxQueue?: number
  /** A turn's length for a lane with no history yet (expectedWait). */
  turnMs?: number
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
  {
    deadlineMs,
    signal,
    onDeadline,
    giveUp,
    maxWaitMs,
    maxQueue,
    turnMs = 2_000,
  }: LaneOptions<T>,
): Promise<T> {
  signal?.throwIfAborted()

  if (giveUp?.aborted) {
    return Promise.reject(new LaneGaveUp())
  }

  const wait = expectedWait(lane, turnMs)
  // The one running is not waiting: those behind it are.
  const waiting = Math.max(0, lane.queued - 1)

  if (
    lane.queued > 0 &&
    ((maxQueue !== undefined && waiting >= maxQueue) ||
      (maxWaitMs !== undefined && wait > maxWaitMs))
  ) {
    return Promise.reject(new LaneBusy(Math.max(wait, turnMs), lane.queued))
  }

  const previous = lane.tail
  let released = false
  let release!: () => void
  lane.queued += 1
  lane.tail = new Promise<void>((resolve) => {
    release = () => {
      if (released) return
      released = true
      lane.queued -= 1
      resolve()
    }
  })

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let started = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      giveUp?.removeEventListener("abort", onGiveUp)
      settle()
    }
    const onAbort = () => {
      finish(() => reject(signal!.reason))
      // Waiting, its turn passes on once the one before it is done; running,
      // it passes on now.
      if (started) release()
      else void previous.then(release)
    }
    const onGiveUp = () => {
      if (started) return
      finish(() => reject(new LaneGaveUp()))
      void previous.then(release)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
    giveUp?.addEventListener("abort", onGiveUp, { once: true })

    void previous.then(async () => {
      if (settled) return

      started = true
      giveUp?.removeEventListener("abort", onGiveUp)
      const began = Date.now()
      lane.runningSince = began
      const done = () => {
        const took = Date.now() - began
        lane.averageMs =
          lane.averageMs === null ? took : lane.averageMs * 0.7 + took * 0.3
        if (lane.runningSince === began) lane.runningSince = null
        release()
      }
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<"deadline">((ring) => {
        timer = setTimeout(() => ring("deadline"), deadlineMs)
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
          done()
        }

        return
      }

      finish(() => (first.ok ? resolve(first.value) : reject(first.error)))
      done()
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
