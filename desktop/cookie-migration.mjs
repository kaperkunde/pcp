// The window used to load PCP at http://localhost:<port>, and Chromium keeps
// a cookie under the host that set it, so the owner's sign-in sits under
// localhost. The window now loads 127.0.0.1 (touch-id-store.mjs, pcpOrigin),
// where that cookie is not sent. This copies PCP's session cookie across, so
// the change does not sign the owner out, and removes the old one: a cookie
// on localhost is sent to every port there, other programs' included. Apart
// from Electron so it can be tested (cookie-migration.test.mjs).

import { pcpOrigin } from "./touch-id-store.mjs"

/** lib/server/session.ts, SESSION_COOKIE; desktop/ imports nothing from lib/. */
export const SESSION_COOKIE = "pcp_session"

/**
 * @param {Pick<import("electron").Cookies, "get" | "set" | "remove">} cookies
 * @param {number} port
 * @param {number} [now] seconds since the epoch
 * @returns {Promise<boolean>} whether a sign-in was moved
 */
export async function moveSessionCookie(
  cookies,
  port,
  now = Date.now() / 1000,
) {
  const from = `http://localhost:${port}/`
  const to = `${pcpOrigin(port)}/`

  const old = (await cookies.get({ url: from, name: SESSION_COOKIE })).find(
    (cookie) => cookie.path === "/",
  )
  if (!old) return false

  // A sign-in already made at the new address is the newer one.
  const current = await cookies.get({ url: to, name: SESSION_COOKIE })
  const live = old.expirationDate === undefined || old.expirationDate > now

  let moved = false
  if (live && current.length === 0) {
    await cookies.set({
      url: to,
      name: SESSION_COOKIE,
      value: old.value,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: old.sameSite,
      expirationDate: old.expirationDate,
    })
    moved = true
  }

  await cookies.remove(from, SESSION_COOKIE)
  return moved
}
