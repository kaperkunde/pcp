import { describe, expect, it } from "vitest"

import { moveSessionCookie, SESSION_COOKIE } from "./cookie-migration.mjs"

/** A cookie jar that answers like Electron's, by host. */
function jar(initial) {
  const stored = new Map(Object.entries(initial))
  const hostOf = (url) => new URL(url).hostname
  return {
    stored,
    async get({ url, name }) {
      return (stored.get(hostOf(url)) ?? []).filter(
        (cookie) => cookie.name === name,
      )
    },
    async set(details) {
      const host = hostOf(details.url)
      stored.set(host, [
        ...(stored.get(host) ?? []).filter(
          (cookie) => cookie.name !== details.name,
        ),
        details,
      ])
    },
    async remove(url, name) {
      const host = hostOf(url)
      stored.set(
        host,
        (stored.get(host) ?? []).filter((cookie) => cookie.name !== name),
      )
    },
  }
}

const cookie = (more = {}) => ({
  name: SESSION_COOKIE,
  value: "secret",
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  expirationDate: 2_000,
  ...more,
})

describe("moveSessionCookie", () => {
  it("moves the sign-in from localhost to 127.0.0.1 and leaves none behind", async () => {
    const cookies = jar({ localhost: [cookie()] })

    expect(await moveSessionCookie(cookies, 3000, 1_000)).toBe(true)

    expect(cookies.stored.get("localhost")).toEqual([])
    expect(cookies.stored.get("127.0.0.1")).toEqual([
      expect.objectContaining({
        name: SESSION_COOKIE,
        value: "secret",
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        expirationDate: 2_000,
      }),
    ])
  })

  it("does nothing when there is no sign-in", async () => {
    const cookies = jar({})

    expect(await moveSessionCookie(cookies, 3000, 1_000)).toBe(false)
    expect(cookies.stored.get("127.0.0.1")).toBeUndefined()
  })

  it("drops an expired sign-in instead of moving it", async () => {
    const cookies = jar({ localhost: [cookie()] })

    expect(await moveSessionCookie(cookies, 3000, 3_000)).toBe(false)
    expect(cookies.stored.get("localhost")).toEqual([])
    expect(cookies.stored.get("127.0.0.1")).toBeUndefined()
  })

  it("keeps a sign-in already made at the new address", async () => {
    const cookies = jar({
      localhost: [cookie()],
      "127.0.0.1": [cookie({ value: "newer" })],
    })

    expect(await moveSessionCookie(cookies, 3000, 1_000)).toBe(false)
    expect(cookies.stored.get("localhost")).toEqual([])
    expect(cookies.stored.get("127.0.0.1")).toEqual([
      expect.objectContaining({ value: "newer" }),
    ])
  })

  it("leaves other cookies on localhost alone", async () => {
    const other = cookie({ name: "theme", value: "dark" })
    const cookies = jar({ localhost: [other, cookie()] })

    await moveSessionCookie(cookies, 3000, 1_000)

    expect(cookies.stored.get("localhost")).toEqual([other])
  })
})
