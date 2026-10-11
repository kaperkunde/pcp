import { createHash } from "node:crypto"

import type { BrowserContext } from "patchright-core"

import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString } from "../crypto"
import { db } from "../db"
import { MAX_PROFILE_BYTES } from "./limits"

/**
 * The browser's sign-ins between runs: its cookies, local storage and
 * IndexedDB, as Playwright's storage state, kept in `browser_profile`
 * encrypted under the vault's data key ("browser_profile:<vaultId>"). The
 * browser itself keeps nothing on disk: its context lives in memory and is
 * started from this, and saved back to it while a request (an assistant's
 * call, or the owner's input) holds the key.
 */

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>

export type ProfileSummary = {
  sites: number
  cookies: number
  size: number
  /** IndexedDB was left out to fit. */
  partial: boolean
  savedAt: Date
}

function aad(vaultId: string): string {
  return `browser_profile:${vaultId}`
}

export async function loadProfile(
  ctx: VaultContext,
): Promise<StorageState | null> {
  const row = await db().browserProfile.findUnique({
    where: { vaultId: ctx.vaultId },
  })

  if (!row) {
    return null
  }

  try {
    return JSON.parse(
      decryptString(ctx.dek, Buffer.from(row.ciphertext), aad(ctx.vaultId)),
    ) as StorageState
  } catch (error) {
    // A profile that does not open starts the browser signed out rather
    // than not at all; the owner can forget it on the Browser page.
    console.error("[browser] the saved profile could not be read", error)
    return null
  }
}

/** The sites a state holds something for: cookie domains and origins. */
export function sitesOf(state: StorageState): number {
  const hosts = new Set<string>()

  for (const cookie of state.cookies) {
    hosts.add(cookie.domain.replace(/^\./, "").toLowerCase())
  }

  for (const origin of state.origins) {
    try {
      hosts.add(new URL(origin.origin).hostname.toLowerCase())
    } catch {
      // An origin Playwright could not name is not a site.
    }
  }

  return hosts.size
}

/** The state as saved: whole if it fits, else without IndexedDB, else cookies only. */
export function fitProfile(
  whole: StorageState,
  withoutIndexedDb: () => Promise<StorageState>,
): Promise<{ json: string; state: StorageState; partial: boolean }> {
  const json = JSON.stringify(whole)

  if (Buffer.byteLength(json) <= MAX_PROFILE_BYTES) {
    return Promise.resolve({ json, state: whole, partial: false })
  }

  return withoutIndexedDb().then((smaller) => {
    const text = JSON.stringify(smaller)

    if (Buffer.byteLength(text) <= MAX_PROFILE_BYTES) {
      return { json: text, state: smaller, partial: true }
    }

    const cookiesOnly: StorageState = { cookies: smaller.cookies, origins: [] }
    const last = JSON.stringify(cookiesOnly)

    if (Buffer.byteLength(last) > MAX_PROFILE_BYTES) {
      throw new Error("the browser's cookies alone are over the limit")
    }

    return { json: last, state: cookiesOnly, partial: true }
  })
}

/**
 * Saves the context's state for the vault. Returns the hash of what was
 * saved, so an unchanged state is not written again.
 */
export async function saveProfile(
  ctx: VaultContext,
  context: BrowserContext,
  { unless }: { unless?: string | null } = {},
): Promise<string | null> {
  const whole = await context.storageState({ indexedDB: true })
  const { json, state, partial } = await fitProfile(whole, () =>
    context.storageState(),
  )
  const hash = createHash("sha256").update(json).digest("hex")

  if (unless && unless === hash) {
    return hash
  }

  const data = {
    ciphertext: asBytes(encryptString(ctx.dek, json, aad(ctx.vaultId))),
    sites: sitesOf(state),
    cookies: state.cookies.length,
    size: Buffer.byteLength(json),
    partial,
    savedAt: new Date(),
  }

  await db().browserProfile.upsert({
    where: { vaultId: ctx.vaultId },
    create: { vaultId: ctx.vaultId, ...data },
    update: data,
  })

  return hash
}

export async function clearProfile(ctx: VaultContext): Promise<void> {
  await db().browserProfile.deleteMany({ where: { vaultId: ctx.vaultId } })
}

/** What the Browser page shows, without decrypting anything. */
export async function profileSummary(
  vaultId: string,
): Promise<ProfileSummary | null> {
  return db().browserProfile.findUnique({
    where: { vaultId },
    select: {
      sites: true,
      cookies: true,
      size: true,
      partial: true,
      savedAt: true,
    },
  })
}
