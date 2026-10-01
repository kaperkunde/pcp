/**
 * Carries a token that was just made from the token list to its own page,
 * where the owner sets what it may run. The value is shown once and never
 * stored, so it travels in this module's memory across the client-side
 * navigation: not in the URL, not in browser storage. A reload or a fresh
 * visit finds nothing, which is the point.
 */

let pending: { id: string; token: string } | null = null

export function handOffNewToken(id: string, token: string) {
  pending = { id, token }
}

/** The token made for this id, if one is waiting to be shown. */
export function peekNewToken(id: string): string | null {
  return pending?.id === id ? pending.token : null
}

/** Forgets the token once its page has it. */
export function clearNewToken(id: string) {
  if (pending?.id === id) {
    pending = null
  }
}
