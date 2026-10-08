import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createApiToken,
  getApiToken,
  resolveApiToken,
} from "@/lib/core/api-tokens"
import { db } from "@/lib/core/db"
import { resetRateLimits } from "@/lib/core/rate-limit"
import {
  createSession,
  resolveSession,
  type ResolvedSession,
} from "@/lib/core/sessions"
import { scratchDatabase } from "@/lib/core/test-db"
import { setupVault } from "@/lib/core/vault"

// A new expiry brings an expired token back: a lasting way into the vault,
// so a session alone, which can be copied, must not give it one.

const signedIn = vi.hoisted(() => ({ session: null as unknown }))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/server/client-ip", () => ({
  clientIp: async () => "192.0.2.1",
}))
vi.mock("@/lib/server/session", () => ({
  requireSession: async () => signedIn.session,
  requireContext: async () => (signedIn.session as ResolvedSession).ctx,
}))

const { updateTokenAction } = await import("./tokens")

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

describe("updateTokenAction", () => {
  it("asks for the owner before an expired token gets a new expiry", async () => {
    const { id, token } = await createApiToken(session.ctx, {
      name: "Claude",
      allowAllServers: true,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await db().apiToken.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const fields = { id, name: "Claude", access: "all" }

    for (const expiresIn of ["30", "never"]) {
      expect(
        await updateTokenAction(IDLE, form({ ...fields, expiresIn })),
      ).toMatchObject({ status: "error" })
      expect(
        await updateTokenAction(
          IDLE,
          form({ ...fields, expiresIn, password: "wrong password" }),
        ),
      ).toMatchObject({ status: "error" })
    }
    expect(await resolveApiToken(token)).toBeNull()

    // Other changes take the session alone, and leave it expired.
    expect(
      await updateTokenAction(
        IDLE,
        form({ ...fields, name: "Old Claude", expiresIn: "keep" }),
      ),
    ).toMatchObject({ status: "ok" })
    expect((await getApiToken(session.ctx, id)).name).toBe("Old Claude")
    expect(await resolveApiToken(token)).toBeNull()

    expect(
      await updateTokenAction(
        IDLE,
        form({ ...fields, expiresIn: "30", password: PASSWORD }),
      ),
    ).toMatchObject({ status: "ok" })
    expect(await resolveApiToken(token)).not.toBeNull()
  })

  it("moves a live token's expiry with the session alone", async () => {
    const { id } = await createApiToken(session.ctx, {
      name: "Claude",
      allowAllServers: true,
    })

    expect(
      await updateTokenAction(
        IDLE,
        form({ id, name: "Claude", access: "all", expiresIn: "7" }),
      ),
    ).toMatchObject({ status: "ok" })
    expect((await getApiToken(session.ctx, id)).expiresAt).not.toBeNull()
  })
})
