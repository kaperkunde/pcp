/**
 * Fixed-window counter in this process's memory. Enough to blunt password
 * guessing and runaway clients on one instance; not shared between
 * replicas and reset on restart.
 */
const store = new Map<string, { count: number; expiresAt: number }>()

// Keys come from callers that can be handed arbitrary values (a forged
// address, say), so the store holds at most this many windows. Past it the
// window touched longest ago is dropped, which only gives that one source a
// fresh count. Instance-wide counters (keys ending in ":*") are never the one
// dropped: they are the cap a flood of new keys must not reset.
const MAX_ENTRIES = 10_000

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

function evictOne() {
  for (const key of store.keys()) {
    if (key.endsWith(":*")) continue
    store.delete(key)
    return
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
    store.delete(key)
    if (store.size >= MAX_ENTRIES) evictOne()
    store.set(key, { count: 1, expiresAt: now + windowMs })
    return true
  }
  // Re-inserted so the Map's order is the order of last use.
  store.delete(key)
  store.set(key, entry)
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

/** Tests: how many windows are held. */
export function rateLimitSize(): number {
  return store.size
}

/** Tests: forget every window. */
export function resetRateLimits(): void {
  store.clear()
}
