import type { BrowserContext } from "patchright-core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { MAX_PROFILE_BYTES } from "./limits"
import {
  clearProfile,
  fitProfile,
  loadProfile,
  profileSummary,
  saveProfile,
  sitesOf,
  type StorageState,
} from "./profile"

// The browser's sign-ins in the vault: encrypted with the vault's key and
// bound to the vault, counted for the page without decrypting, and cut
// down to fit when a site stores too much.

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await cleanup()
})

const cookie = (domain: string, value = "v") => ({
  name: "sid",
  value,
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
})

function contextWith(state: StorageState): BrowserContext {
  return { storageState: async () => state } as unknown as BrowserContext
}

describe("the browser's profile", () => {
  it("is saved encrypted, read back with the key, and counted without it", async () => {
    const state: StorageState = {
      cookies: [cookie(".example.com", "very-secret"), cookie("shop.example")],
      origins: [
        {
          origin: "https://app.example.org",
          localStorage: [{ name: "t", value: "1" }],
        },
      ],
    }

    const hash = await saveProfile(ctx, contextWith(state))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const row = await db().browserProfile.findUniqueOrThrow({
      where: { vaultId: ctx.vaultId },
    })
    expect(Buffer.from(row.ciphertext).toString("latin1")).not.toContain(
      "very-secret",
    )
    expect(await profileSummary(ctx.vaultId)).toMatchObject({
      sites: 3,
      cookies: 2,
      partial: false,
    })
    expect(await loadProfile(ctx)).toEqual(state)

    // Unchanged, it is not written again.
    const before = row.savedAt
    await saveProfile(ctx, contextWith(state), { unless: hash })
    expect(
      (
        await db().browserProfile.findUniqueOrThrow({
          where: { vaultId: ctx.vaultId },
        })
      ).savedAt,
    ).toEqual(before)

    await clearProfile(ctx)
    expect(await loadProfile(ctx)).toBeNull()
  })

  it("does not open for another vault's key", async () => {
    await saveProfile(
      ctx,
      contextWith({ cookies: [cookie("a.example")], origins: [] }),
    )
    const other = { ...ctx, dek: Buffer.alloc(32, 7) }
    expect(await loadProfile(other)).toBeNull()
  })

  it("leaves IndexedDB out, then local storage, when the whole would not fit", async () => {
    const big = "x".repeat(MAX_PROFILE_BYTES)
    const whole = {
      cookies: [cookie("a.example")],
      origins: [
        {
          origin: "https://a.example",
          localStorage: [{ name: "k", value: big }],
        },
      ],
    } as StorageState
    const smaller: StorageState = {
      cookies: [cookie("a.example")],
      origins: [
        {
          origin: "https://a.example",
          localStorage: [{ name: "k", value: "1" }],
        },
      ],
    }

    expect(await fitProfile(smaller, async () => smaller)).toMatchObject({
      partial: false,
    })
    expect(await fitProfile(whole, async () => smaller)).toMatchObject({
      state: smaller,
      partial: true,
    })
    expect(await fitProfile(whole, async () => whole)).toMatchObject({
      state: { cookies: whole.cookies, origins: [] },
      partial: true,
    })
  })

  it("counts each site once", () => {
    expect(
      sitesOf({
        cookies: [
          cookie(".example.com"),
          cookie("example.com"),
          cookie("b.example"),
        ],
        origins: [{ origin: "https://example.com", localStorage: [] }],
      }),
    ).toBe(2)
  })
})
