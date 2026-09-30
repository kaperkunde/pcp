import "server-only"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import type { VaultContext } from "@/lib/core/context"
import { resolveSession, type ResolvedSession } from "@/lib/core/sessions"
import { isSetUp } from "@/lib/core/vault"

/**
 * The browser's session, from the cookie. One lookup per request (React's
 * cache), so a layout and the page under it do not both unwrap the key.
 */

export const SESSION_COOKIE = "pcp_session"

export const currentSession = cache(
  async (): Promise<ResolvedSession | null> => {
    const jar = await cookies()
    return resolveSession(jar.get(SESSION_COOKIE)?.value)
  },
)

/** Signed in, or sent to /login (or /setup before the first sign-in). */
export async function requireSession(): Promise<ResolvedSession> {
  const session = await currentSession()

  if (session) {
    return session
  }

  redirect((await isSetUp()) ? "/login" : "/setup")
}

export async function requireContext(): Promise<VaultContext> {
  return (await requireSession()).ctx
}

export async function isSecureRequest(): Promise<boolean> {
  const hdrs = await headers()
  const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim()

  return proto === "https"
}

export async function writeSessionCookie(
  value: string,
  expiresAt: Date,
): Promise<void> {
  const jar = await cookies()

  jar.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    // Only over TLS when the request came over TLS: a LAN install on plain
    // http would otherwise never see its own cookie again.
    secure: await isSecureRequest(),
    path: "/",
    expires: expiresAt,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
}
