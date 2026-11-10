import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"
import { isSealedText, openFromText, sealToText } from "./sealed"

/**
 * Per-vault settings the owner changes in the UI. Their values are sealed
 * under the vault's key ("setting:<vault id>:<key>"), all but the ones a
 * request without the key reads (PLAIN_SETTINGS); a value from before
 * stays readable as it was until the vault's rows are converted.
 */

export const SETTING_PUBLIC_URL = "publicUrl"

/**
 * Read without the vault being unlocked: the public URL, for PCP's OAuth
 * client metadata document and the links of a request with no session.
 */
export const PLAIN_SETTINGS: ReadonlySet<string> = new Set([SETTING_PUBLIC_URL])

export function settingAad(vaultId: string, key: string): string {
  return `setting:${vaultId}:${key}`
}

export async function getSetting(
  ctx: VaultContext,
  key: string,
): Promise<string | null> {
  const row = await db().setting.findUnique({
    where: { vaultId_key: { vaultId: ctx.vaultId, key } },
  })

  return row
    ? openFromText(ctx.dek, settingAad(ctx.vaultId, key), row.value)
    : null
}

/**
 * A setting read without the vault being unlocked: one of PLAIN_SETTINGS
 * only, never a sealed one.
 */
export async function getVaultSetting(
  vaultId: string,
  key: string,
): Promise<string | null> {
  if (!PLAIN_SETTINGS.has(key)) {
    throw new Error(`the setting ${key} is read with the vault's key`)
  }

  const row = await db().setting.findUnique({
    where: { vaultId_key: { vaultId, key } },
  })

  return row && !isSealedText(row.value) ? row.value : null
}

/** What a setting's value is stored as. */
export function storedSetting(
  ctx: VaultContext,
  key: string,
  value: string,
): string {
  return PLAIN_SETTINGS.has(key)
    ? value
    : sealToText(ctx.dek, settingAad(ctx.vaultId, key), value)
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

  const stored = storedSetting(ctx, key, value)

  await db().setting.upsert({
    where: { vaultId_key: { vaultId: ctx.vaultId, key } },
    create: { vaultId: ctx.vaultId, key, value: stored },
    update: { value: stored },
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
