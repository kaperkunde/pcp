import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createApiToken,
  getApiToken,
  resolveApiToken,
  revivesToken,
  updateApiToken,
} from "./api-tokens"
import { db } from "./db"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// An expired token keeps its copy of the key: a new expiry makes it work
// again, which takes the owner, not a session alone.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const DAY_MS = 24 * 60 * 60 * 1000

async function expiredToken() {
  const ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { id, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    expiresAt: new Date(Date.now() + DAY_MS),
  })
  await db().apiToken.update({
    where: { id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })

  return { ctx, id, token }
}

describe("revivesToken", () => {
  it("is a new expiry, or none, for a token whose expiry has passed", () => {
    const past = { expiresAt: new Date(Date.now() - 1000) }
    const future = { expiresAt: new Date(Date.now() + DAY_MS) }
    const never = { expiresAt: null }
    const later = new Date(Date.now() + 7 * DAY_MS)

    expect(revivesToken(past, later)).toBe(true)
    expect(revivesToken(past, null)).toBe(true)
    expect(revivesToken(past, undefined)).toBe(false)
    expect(revivesToken(future, later)).toBe(false)
    expect(revivesToken(future, null)).toBe(false)
    expect(revivesToken(never, later)).toBe(false)
  })
})

describe("updating an expired token", () => {
  it("refuses a new expiry, or none, unless the owner confirmed", async () => {
    const { ctx, id, token } = await expiredToken()
    const before = (await getApiToken(ctx, id)).expiresAt

    for (const expiresAt of [new Date(Date.now() + 7 * DAY_MS), null]) {
      await expect(
        updateApiToken(ctx, id, {
          name: "Claude",
          allowAllServers: true,
          expiresAt,
        }),
      ).rejects.toThrow(/expired/)
    }
    expect((await getApiToken(ctx, id)).expiresAt).toEqual(before)
    expect(await resolveApiToken(token)).toBeNull()

    // Anything else is still the session's to change.
    await updateApiToken(ctx, id, { name: "Old Claude", allowAllServers: true })
    expect((await getApiToken(ctx, id)).name).toBe("Old Claude")
    expect(await resolveApiToken(token)).toBeNull()

    await updateApiToken(
      ctx,
      id,
      { name: "Old Claude", allowAllServers: true, expiresAt: null },
      { ownerConfirmed: true },
    )
    expect((await getApiToken(ctx, id)).expiresAt).toBeNull()
    expect(await resolveApiToken(token)).not.toBeNull()
  })

  it("moves a live token's expiry with a session alone", async () => {
    const ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
    const { id } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
      expiresAt: new Date(Date.now() + DAY_MS),
    })

    await updateApiToken(ctx, id, {
      name: "Claude",
      allowAllServers: true,
      expiresAt: null,
    })
    expect((await getApiToken(ctx, id)).expiresAt).toBeNull()
  })
})
