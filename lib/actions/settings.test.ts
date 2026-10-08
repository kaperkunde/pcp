import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetRateLimits } from "@/lib/core/rate-limit"
import {
  createSession,
  resolveSession,
  type ResolvedSession,
} from "@/lib/core/sessions"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { scratchDatabase } from "@/lib/core/test-db"
import { setupVault } from "@/lib/core/vault"

// The public address decides where sign-ins and permission links go: a
// session alone, which can be copied, must not move it.

const signedIn = vi.hoisted(() => ({ session: null as unknown }))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("next/navigation", () => ({ redirect: () => {} }))
vi.mock("@/lib/server/client-ip", () => ({
  clientIp: async () => "192.0.2.1",
}))
vi.mock("@/lib/server/session", () => ({
  requireSession: async () => signedIn.session,
  requireContext: async () => (signedIn.session as ResolvedSession).ctx,
  clearSessionCookie: async () => {},
}))

const { setPublicUrlAction } = await import("./settings")

const PASSWORD = "correct horse battery staple"
const IDLE = { status: "idle" } as const

let cleanup: () => Promise<void>
let session: ResolvedSession

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  resetRateLimits()
  const ctx = await setupVault({ name: "Ada", password: PASSWORD })
  const { cookieValue } = await createSession(ctx)
  session = (await resolveSession(cookieValue))!
  signedIn.session = session
})

afterEach(async () => {
  resetRateLimits()
  await cleanup()
})

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(values)) data.set(name, value)
  return data
}

function pinned() {
  return getSetting(session.ctx, SETTING_PUBLIC_URL)
}

describe("setPublicUrlAction", () => {
  it("pins and clears the address only with the password", async () => {
    const elsewhere = "https://elsewhere.example"

    expect(
      await setPublicUrlAction(IDLE, form({ publicUrl: elsewhere })),
    ).toMatchObject({ status: "error" })
    expect(
      await setPublicUrlAction(
        IDLE,
        form({ publicUrl: elsewhere, password: "wrong password" }),
      ),
    ).toMatchObject({ status: "error", error: expect.stringMatching(/right/) })
    expect(await pinned()).toBeNull()

    expect(
      await setPublicUrlAction(
        IDLE,
        form({ publicUrl: `${elsewhere}/`, password: PASSWORD }),
      ),
    ).toMatchObject({ status: "ok" })
    expect(await pinned()).toBe(elsewhere)

    // Clearing it moves where links point as much as setting it does.
    expect(
      await setPublicUrlAction(IDLE, form({ publicUrl: "" })),
    ).toMatchObject({ status: "error" })
    expect(await pinned()).toBe(elsewhere)

    expect(
      await setPublicUrlAction(
        IDLE,
        form({ publicUrl: "", password: PASSWORD }),
      ),
    ).toMatchObject({ status: "ok" })
    expect(await pinned()).toBeNull()
  })

  it("takes Touch ID's key in place of the password", async () => {
    expect(
      await setPublicUrlAction(
        IDLE,
        form({ publicUrl: "https://pcp.example", deviceKey: "not the key" }),
      ),
    ).toMatchObject({ status: "error" })
    expect(await pinned()).toBeNull()
  })

  it("refuses an address that is no address before it asks", async () => {
    expect(
      await setPublicUrlAction(
        IDLE,
        form({ publicUrl: "ftp://pcp.example", password: "wrong password" }),
      ),
    ).toMatchObject({ status: "error", error: expect.stringMatching(/http/) })
  })
})
