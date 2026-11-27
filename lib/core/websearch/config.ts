import { z } from "zod"

import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid } from "../errors"
import { byName, SECRET_META_SELECT, secretName } from "../secret-meta"
import { getSetting, setSetting } from "../settings"
import { WEB_SEARCH_MAX_URL_SETTING_CHARS } from "./limits"
import {
  isWebSearchProvider,
  PROVIDER_INFO,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from "./providers"

/**
 * The owner's search provider for web_search (Settings → Web search), kept
 * as the vault's setting SETTING_WEB_SEARCH: it names the owner's secret,
 * so it is the vault's, never the machine's. None set means web_search
 * answers with the owner's link to set one up. It holds no secret, only
 * its id; upstream.ts reads the secret when a search is made.
 */

export const SETTING_WEB_SEARCH = "webSearch"

export type WebSearchConfig = {
  provider: WebSearchProvider
  /** A text secret: the API key (optional for a search the owner runs). */
  secretId: string | null
  /** A search the owner runs: its address. */
  url?: string
}

const Id = z.string().min(1).max(100)

const ConfigSchema = z.strictObject({
  provider: z.enum(WEB_SEARCH_PROVIDERS),
  secretId: Id.nullable(),
  url: z.string().min(1).max(WEB_SEARCH_MAX_URL_SETTING_CHARS).optional(),
})

/**
 * The vault's provider, or null for none. A value that does not read as
 * one (a hand-edited export) counts as none.
 */
export async function readWebSearchConfig(
  ctx: VaultContext,
): Promise<WebSearchConfig | null> {
  const raw = await getSetting(ctx, SETTING_WEB_SEARCH)

  if (!raw) {
    return null
  }

  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** An address the owner typed, as http(s) with no credentials in it. */
export function checkSearchUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    throw invalid(
      "Enter the search server's full address, like https://search.example.com.",
    )
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("The address must start with http:// or https://.")
  }

  if (url.username || url.password) {
    throw invalid(
      "Leave the user name and password out of the address: choose a secret instead.",
    )
  }

  if (trimmed.length > WEB_SEARCH_MAX_URL_SETTING_CHARS) {
    throw invalid(
      `Keep the address under ${WEB_SEARCH_MAX_URL_SETTING_CHARS} characters.`,
    )
  }

  return trimmed.replace(/\/+$/, "")
}

/**
 * A provider as the owner set it on Settings, checked: a text secret of the
 * vault where the provider takes a key, an http(s) address where the owner
 * runs it. Throws a message for the owner.
 */
export async function checkWebSearchConfig(
  ctx: VaultContext,
  input: WebSearchConfig,
): Promise<WebSearchConfig> {
  if (!isWebSearchProvider(input.provider)) {
    throw invalid("Choose a provider.")
  }

  const info = PROVIDER_INFO[input.provider]

  if (input.secretId) {
    const row = await db().secret.findFirst({
      where: { id: input.secretId, vaultId: ctx.vaultId },
      select: { kind: true },
    })

    if (row?.kind !== "text") {
      throw invalid("Choose the API key from your secrets.")
    }
  } else if (!info.keyOptional) {
    throw invalid(`Choose the secret that holds your ${info.title} API key.`)
  }

  if (info.ownAddress) {
    if (!input.url) {
      throw invalid("Enter your search server's address.")
    }

    return {
      provider: input.provider,
      secretId: input.secretId,
      url: checkSearchUrl(input.url),
    }
  }

  return { provider: input.provider, secretId: input.secretId }
}

/** Writes the provider (null for none). */
export async function writeWebSearchConfig(
  ctx: VaultContext,
  config: WebSearchConfig | null,
): Promise<void> {
  await setSetting(
    ctx,
    SETTING_WEB_SEARCH,
    config ? JSON.stringify(ConfigSchema.parse(config)) : null,
  )
}

/** What Settings shows: nothing secret, the key by its name. */
export type WebSearchOverview = {
  config: WebSearchConfig | null
  /** The vault's text secrets, to choose an API key from. */
  secrets: Array<{ id: string; name: string }>
}

export async function webSearchOverview(
  ctx: VaultContext,
): Promise<WebSearchOverview> {
  const [config, secrets] = await Promise.all([
    readWebSearchConfig(ctx),
    db()
      .secret.findMany({
        where: { vaultId: ctx.vaultId, kind: "text" },
        select: SECRET_META_SELECT,
      })
      .then((rows) =>
        rows
          .map((row) => ({ id: row.id, name: secretName(ctx, row) }))
          .sort(byName),
      ),
  ])

  return { config, secrets }
}
