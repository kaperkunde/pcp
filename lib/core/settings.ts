import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"

/** Per-vault settings the owner changes in the UI. */

export const SETTING_PUBLIC_URL = "publicUrl"

export async function getSetting(
  ctx: VaultContext,
  key: string,
): Promise<string | null> {
  const row = await db().setting.findUnique({
    where: { vaultId_key: { vaultId: ctx.vaultId, key } },
  })

  return row?.value ?? null
}

export async function setSetting(
  ctx: VaultContext,
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null || value === "") {
    await db().setting.deleteMany({ where: { vaultId: ctx.vaultId, key } })
    return
  }

  await db().setting.upsert({
    where: { vaultId_key: { vaultId: ctx.vaultId, key } },
    create: { vaultId: ctx.vaultId, key, value },
    update: { value },
  })
}

/** An absolute http(s) origin, without a trailing slash, or a problem. */
export function normalizePublicUrl(input: string): string {
  const trimmed = input.trim()

  if (!trimmed) {
    return ""
  }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    throw invalid("Enter a full address, like https://pcp.example.com.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("The public address must start with http:// or https://.")
  }

  if (url.search || url.hash) {
    throw invalid("Leave query strings and fragments out of the address.")
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}
