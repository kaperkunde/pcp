import { createHash } from "node:crypto"

import { requireLiveToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"
import { siteKey } from "./fetch/rules"
import {
  openRuleKey,
  ruleKey,
  ruleKeys,
  sealedRuleKey,
  sealRuleRows,
} from "./fetch-rule-keys"
import { newId } from "./ids"
import { PERMISSION_TTL_MS } from "./permission-rules"

/**
 * Whether the browser's evaluate may run an assistant's script at a site
 * (browser/evaluate.ts), per token: the owner's answer to a `script_use`
 * request, which shows the site and the whole script.
 *
 * "Allow scripts at this site" and "Block scripts at this site" are a level,
 * kept as a web_fetch_rule of kind "script" keyed by the site (siteKey: the
 * host, and a port that is not the scheme's own), as exits are: the token's
 * own, or for all tokens, the token's own winning. Only the owner writes one,
 * by their answer or on the token's page; nothing an assistant sends does.
 * Without a line evaluate asks.
 *
 * "Run it once" is not a level: an allowance for that one script, in that
 * tab at that site, held in memory until the call the answer makes takes
 * it (or the request would have expired), never saved and never exported.
 */

const KIND = "script"
const ALL = "all"

export type ScriptLevel = "allowed" | "blocked"

function asLevel(value: string | null | undefined): ScriptLevel | null {
  return value === "allowed" || value === "blocked" ? value : null
}

/** The token's level for scripts at a site: its own, else all tokens'; null asks. */
export async function decideScript(
  ctx: VaultContext,
  tokenId: string,
  site: string,
): Promise<ScriptLevel | null> {
  const rows = await db().webFetchRule.findMany({
    where: {
      vaultId: ctx.vaultId,
      kind: KIND,
      key: { in: ruleKeys(ctx, KIND, site) },
      scope: { in: [tokenId, ALL] },
    },
  })

  return (
    asLevel(rows.find((row) => row.scope === tokenId)?.access) ??
    asLevel(rows.find((row) => row.scope === ALL)?.access)
  )
}

/**
 * Writes the token's own level for scripts at a site (null tokenId: for all
 * tokens). The owner's alone: their answer to a request, or the token's page.
 */
export async function writeScriptAccess(
  ctx: VaultContext,
  tokenId: string | null,
  site: string,
  access: ScriptLevel,
): Promise<void> {
  const scope = tokenId ?? ALL
  const vaultId = ctx.vaultId
  const id = newId()

  await sealRuleRows(ctx, KIND, site)
  await db().webFetchRule.upsert({
    where: {
      vaultId_scope_kind_key: {
        vaultId,
        scope,
        kind: KIND,
        key: ruleKey(ctx, KIND, site),
      },
    },
    create: {
      id,
      vaultId,
      tokenId,
      scope,
      kind: KIND,
      ...sealedRuleKey(ctx, id, KIND, site),
      access,
      addedBy: "owner",
    },
    update: { access },
  })
}

export type ScriptSiteView = { site: string; access: ScriptLevel }

/** The token's own lines for scripts, for its page. */
export async function listScriptSites(
  ctx: VaultContext,
  tokenId: string,
): Promise<ScriptSiteView[]> {
  const rows = await db().webFetchRule.findMany({
    where: { vaultId: ctx.vaultId, kind: KIND, scope: tokenId },
  })

  return rows
    .flatMap((row) => {
      const access = asLevel(row.access)
      return access ? [{ site: openRuleKey(ctx, row), access }] : []
    })
    .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))
}

/** Takes away a token's own line for scripts at a site: evaluate asks again. */
export async function removeScriptSite(
  ctx: VaultContext,
  tokenId: string,
  site: string,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)

  if (typeof site !== "string" || site === "" || site.length > 300) {
    throw invalid("Name the site.")
  }

  await db().webFetchRule.deleteMany({
    where: {
      vaultId: ctx.vaultId,
      kind: KIND,
      scope: tokenId,
      key: { in: ruleKeys(ctx, KIND, site) },
    },
  })
}

/** The site an address is at, for scripts; null for one that is no site. */
export function scriptSiteOf(address: string): string | null {
  try {
    const url = new URL(address)
    return url.protocol === "http:" || url.protocol === "https:"
      ? siteKey(url)
      : null
  } catch {
    return null
  }
}

/** A script's fingerprint, for the request's key and the once allowance. */
export function scriptDigest(script: string): string {
  return createHash("sha256").update(script).digest("base64url")
}

type Once = { tokenId: string; tabId: string; site: string; script: string }

const ONCE = Symbol.for("pcp.browser-scripts.once")

function onceMap(): Map<string, number> {
  const holder = globalThis as unknown as { [ONCE]?: Map<string, number> }
  holder[ONCE] ??= new Map()
  return holder[ONCE]
}

function onceKey({ tokenId, tabId, site, script }: Once): string {
  return [tokenId, tabId, site, scriptDigest(script)].join("\n")
}

/** The owner's "Run it once": this script, in this tab, at this site. */
export function allowScriptOnce(once: Once): void {
  const map = onceMap()
  const now = Date.now()

  for (const [key, until] of map) {
    if (until < now) map.delete(key)
  }

  map.set(onceKey(once), now + PERMISSION_TTL_MS)
}

/** Takes a once allowance for this very script, if there is one. */
export function takeScriptOnce(once: Once): boolean {
  const map = onceMap()
  const key = onceKey(once)
  const until = map.get(key)
  map.delete(key)
  return until !== undefined && until >= Date.now()
}

/** Drops a once allowance the call did not take (the tab moved on). */
export function dropScriptOnce(once: Once): void {
  onceMap().delete(onceKey(once))
}
