import "server-only"

import { verifyDeviceKey } from "@/lib/core/device-keys"
import { PcpError } from "@/lib/core/errors"
import { checkRateLimit, refundRateLimit } from "@/lib/core/rate-limit"
import type { ResolvedSession } from "@/lib/core/sessions"
import { verifyPassword } from "@/lib/core/vault"
import { field } from "@/lib/server/action-state"
import { clientIp } from "@/lib/server/client-ip"

/**
 * How often a password or recovery key may be tried. Every guess is a
 * 64 MiB scrypt run, and a stolen session must be no better a place to guess
 * the password from than the sign-in page.
 *
 * The limits are for guesses. A try that turns out right gives its count
 * back (forgiveSignInTry, forgiveSessionTry): someone without the password
 * cannot do that, and the owner signing in and confirming all day never
 * locks themselves out, nor spends the tries an attacker is held to.
 */

const WINDOW_MS = 15 * 60 * 1000
const PER_SOURCE = { max: 10, windowMs: WINDOW_MS }
// Per-address limits trust X-Forwarded-For, which a client reaching PCP
// without a proxy can set to anything. This one does not: it caps how many
// guesses the instance takes at all.
const GLOBAL = { max: 60, windowMs: WINDOW_MS }

export const TOO_MANY_ATTEMPTS =
  "Too many attempts. Wait a few minutes and try again."

type SignInKind = "password" | "recovery-key" | "export" | "touch-id"
type SessionKind = "password" | "touch-id" | "export"

// One place builds each pair of keys, for the check and for the refund
// alike: a refund under a key nothing counted would give back nothing.
async function signInKeys(kind: SignInKind): Promise<[string, string]> {
  return [`${kind}:${await clientIp()}`, `${kind}:*`]
}

function sessionKeys(kind: SessionKind, sessionId: string): [string, string] {
  return [`${kind}:session:${sessionId}`, `${kind}:*`]
}

function within([own, all]: [string, string]): boolean {
  return checkRateLimit(own, PER_SOURCE) && checkRateLimit(all, GLOBAL)
}

function refund([own, all]: [string, string]): void {
  refundRateLimit(own)
  refundRateLimit(all)
}

/**
 * A password, recovery key or export password typed on a signed-out page,
 * or the Mac app's Touch ID key, per address.
 */
export async function withinSignInLimits(kind: SignInKind): Promise<boolean> {
  return within(await signInKeys(kind))
}

/** A sign-in of `kind` was right: its try was no guess. */
export async function forgiveSignInTry(kind: SignInKind): Promise<void> {
  refund(await signInKeys(kind))
}

/**
 * The password typed again inside a session. Counted per session, which a
 * client cannot forge the way it can an address, and against the same
 * instance-wide cap as sign-in.
 */
export function withinSessionLimits(sessionId: string): boolean {
  return within(sessionKeys("password", sessionId))
}

/**
 * The Mac app's Touch ID key handed over inside a session (confirmOwner).
 * Not a guess at the password: a random 256-bit key checked with HKDF, not
 * a 64 MiB scrypt run. So it neither spends the owner's password tries nor
 * goes unlimited: a budget of its own, per session and for the instance.
 */
export function withinTouchIdLimits(sessionId: string): boolean {
  return within(sessionKeys("touch-id", sessionId))
}

/** The password (or the Touch ID key) inside a session was right. */
export function forgiveSessionTry(
  sessionId: string,
  kind: "password" | "touch-id" = "password",
): void {
  refund(sessionKeys(kind, sessionId))
}

/**
 * An export password typed inside a session, to open an export file. As
 * slow a guess as the owner's password, and counted apart from it, so
 * checking a file does not use up the owner's own tries.
 */
export function withinExportLimits(sessionId: string): boolean {
  return within(sessionKeys("export", sessionId))
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
  forgiveSessionTry(session.sessionId)
}

/**
 * The owner again, before a new API token (or a new expiry for an expired
 * one), a new public address, an export, a restore or deleting the vault:
 * the password (`password`), or in the Mac app the Touch ID key (`deviceKey`,
 * lib/core/device-keys.ts), which that app hands over only after Touch ID.
 * A new recovery key and a new password take the password itself: they
 * decide who gets in, and Touch ID must not.
 */
export async function confirmOwner(
  session: ResolvedSession,
  formData: FormData,
): Promise<void> {
  const deviceKey = field(formData, "deviceKey")

  if (!deviceKey) {
    return confirmPassword(session, field(formData, "password"))
  }

  if (!withinTouchIdLimits(session.sessionId)) {
    throw new PcpError("forbidden", TOO_MANY_ATTEMPTS)
  }

  await verifyDeviceKey(session.ctx, deviceKey)
  forgiveSessionTry(session.sessionId, "touch-id")
}
