/**
 * Waiting for the owner. Nothing can wake an assistant from outside its
 * conversation: an MCP server cannot start a turn, and the owner answering
 * on PCP's page reaches no app. So a check that would answer "still
 * waiting" holds the call open instead and answers as soon as the owner has
 * done their part. The assistant, still in its turn, carries on by itself.
 */

/**
 * How long one check holds a call. Under the minute at which clients and
 * proxies tend to give up on a request; a longer wait is a second check.
 */
export const OWNER_WAIT_MS = 45_000

const POLL_MS = 1_000

/**
 * Calls `ready` until it returns something other than null, `ms` pass, or
 * `signal` aborts (the client went away). Returns the last value: null when
 * it gave up.
 */
export async function waitForOwner<T>(
  ready: () => Promise<T | null>,
  {
    ms = OWNER_WAIT_MS,
    pollMs = POLL_MS,
    signal,
  }: { ms?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  const deadline = Date.now() + ms

  for (;;) {
    const value = await ready()

    if (value !== null || signal?.aborted || Date.now() >= deadline) {
      return value
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollMs, deadline - Date.now()))
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}
