import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PcpError } from "@/lib/core/errors"
import { resetRateLimits } from "@/lib/core/rate-limit"
import type { ResolvedSession } from "@/lib/core/sessions"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/client-ip", () => ({
  clientIp: async () => "192.0.2.1",
}))

// The right password and the right Touch ID key; anything else is refused,
// as the real checks refuse it.
vi.mock("@/lib/core/vault", () => ({
  verifyPassword: async (_ctx: unknown, password: string) => {
    if (password !== "right") {
      throw new PcpError("unauthorized", "That password is not right.")
    }
  },
}))
vi.mock("@/lib/core/device-keys", () => ({
  verifyDeviceKey: async (_ctx: unknown, key: string) => {
    if (key !== "right-key") {
      throw new PcpError("unauthorized", "Touch ID is no longer set up.")
    }
  },
}))

const {
  confirmOwner,
  confirmPassword,
  forgiveSignInTry,
  TOO_MANY_ATTEMPTS,
  withinSessionLimits,
  withinSignInLimits,
} = await import("./password-attempts")

const session = { sessionId: "s1", ctx: {} } as unknown as ResolvedSession

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(values)) data.set(name, value)
  return data
}

beforeEach(() => {
  resetRateLimits()
})

afterEach(() => {
  resetRateLimits()
})

describe("password tries", () => {
  it("gives a right password's try back, and counts wrong ones", async () => {
    for (let i = 0; i < 30; i++) {
      await confirmPassword(session, "right")
    }

    for (let i = 0; i < 10; i++) {
      await expect(confirmPassword(session, "wrong")).rejects.toThrow(
        "not right",
      )
    }

    await expect(confirmPassword(session, "right")).rejects.toThrow(
      TOO_MANY_ATTEMPTS,
    )
  })

  it("gives a right sign-in's try back, at the address and for the instance", async () => {
    for (let i = 0; i < 70; i++) {
      expect(await withinSignInLimits("password")).toBe(true)
      await forgiveSignInTry("password")
    }

    for (let i = 0; i < 10; i++) {
      expect(await withinSignInLimits("password")).toBe(true)
    }
    expect(await withinSignInLimits("password")).toBe(false)
  })

  it("keeps Touch ID confirmations off the password's budget", async () => {
    // Wrong keys spend Touch ID's own tries, not the password's.
    for (let i = 0; i < 10; i++) {
      await expect(
        confirmOwner(session, form({ deviceKey: "wrong-key" })),
      ).rejects.toThrow("no longer set up")
    }
    await expect(
      confirmOwner(session, form({ deviceKey: "right-key" })),
    ).rejects.toThrow(TOO_MANY_ATTEMPTS)
    await confirmOwner(session, form({ password: "right" }))

    // And right keys give theirs back.
    resetRateLimits()
    for (let i = 0; i < 30; i++) {
      await confirmOwner(session, form({ deviceKey: "right-key" }))
    }
    for (let i = 0; i < 10; i++) {
      expect(withinSessionLimits(session.sessionId)).toBe(true)
    }
    expect(withinSessionLimits(session.sessionId)).toBe(false)
  })
})
