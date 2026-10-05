/**
 * Fixed-window counter in this process's memory. Enough to blunt password
 * guessing and runaway clients on one instance; not shared between
 * replicas and reset on restart.
 */
const store = new Map<string, { count: number; expiresAt: number }>()

const PRUNE_INTERVAL_MS = 60_000
let lastPruned = 0

function pruneExpired() {
  const now = Date.now()
  if (now - lastPruned < PRUNE_INTERVAL_MS) return
  lastPruned = now
  for (const [key, value] of store) {
    if (now >= value.expiresAt) store.delete(key)
  }
}

export function checkRateLimit(
  key: string,
  { max, windowMs }: { max: number; windowMs: number },
): boolean {
  pruneExpired()
  const now = Date.now()
  const entry = store.get(key)
  if (!entry || now >= entry.expiresAt) {
    store.set(key, { count: 1, expiresAt: now + windowMs })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

/**
 * Gives back one count taken in the current window, for an attempt that
 * turned out not to be one the limit is for (a right password is not a
 * guess). Never below zero, and nothing for a window already gone.
 */
export function refundRateLimit(key: string): void {
  const entry = store.get(key)
  if (entry && Date.now() < entry.expiresAt && entry.count > 0) {
    entry.count--
  }
}

/** Tests: forget every window. */
export function resetRateLimits(): void {
  store.clear()
}
