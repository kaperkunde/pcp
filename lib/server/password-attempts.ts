import "server-only"

import { PcpError } from "@/lib/core/errors"
import { checkRateLimit } from "@/lib/core/rate-limit"
import type { ResolvedSession } from "@/lib/core/sessions"
import { verifyPassword } from "@/lib/core/vault"
import { clientIp } from "@/lib/server/client-ip"

/**
 * How often a password or recovery key may be tried. Every guess is a
 * 64 MiB scrypt run, and a stolen session must be no better a place to guess
 * the password from than the sign-in page.
 */

const WINDOW_MS = 15 * 60 * 1000
const PER_SOURCE = { max: 10, windowMs: WINDOW_MS }
// Per-address limits trust X-Forwarded-For, which a client reaching PCP
// without a proxy can set to anything. This one does not: it caps how many
// guesses the instance takes at all.
const GLOBAL = { max: 60, windowMs: WINDOW_MS }

export const TOO_MANY_ATTEMPTS =
  "Too many attempts. Wait a few minutes and try again."

/** A password or recovery key typed on a signed-out page, per address. */
export async function withinSignInLimits(
  kind: "password" | "recovery-key",
): Promise<boolean> {
  return (
    checkRateLimit(`${kind}:${await clientIp()}`, PER_SOURCE) &&
    checkRateLimit(`${kind}:*`, GLOBAL)
  )
}

/**
 * The password typed again inside a session. Counted per session, which a
 * client cannot forge the way it can an address, and against the same
 * instance-wide cap as sign-in.
 */
export function withinSessionLimits(sessionId: string): boolean {
  return (
    checkRateLimit(`password:session:${sessionId}`, PER_SOURCE) &&
    checkRateLimit("password:*", GLOBAL)
  )
}

/**
 * The password again, before something that would outlast the session: a
 * new API token or a new recovery key. A session cookie can be copied, so a
 * session may use the vault but not hand out a lasting way into it.
 */
export async function confirmPassword(
  session: ResolvedSession,
  password: string,
): Promise<void> {
  if (!withinSessionLimits(session.sessionId)) {
    throw new PcpError("forbidden", TOO_MANY_ATTEMPTS)
  }

  await verifyPassword(session.ctx, password)
}
