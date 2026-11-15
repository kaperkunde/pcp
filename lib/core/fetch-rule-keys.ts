import type { VaultContext } from "./context"
import { keyedHash } from "./crypto"
import { db } from "./db"
import { openText, sealText, type Sealed } from "./sealed"

/**
 * A web_fetch_rule that names a site (kind "site", and "script" for the
 * browser's evaluate) is keyed by a keyed hash of the site under the
 * vault's key, the site itself sealed beside it as
 * "web_fetch_rule:<id>:key" (#96). The other kinds keep their key as it
 * is: a method, "private", an exit's id. A row from before holds the site
 * in plain text and nothing sealed; a lookup asks for both forms, and a
 * write seals the row it touches first (sealRuleRows), so a site never has
 * two rows in one scope.
 */

const SEALED_KINDS: ReadonlySet<string> = new Set(["site", "script"])

function aad(id: string): string {
  return `web_fetch_rule:${id}:key`
}

/** What the key column holds for a rule of `kind` at `key`. */
export function ruleKey(ctx: VaultContext, kind: string, key: string): string {
  return SEALED_KINDS.has(kind)
    ? keyedHash(ctx.dek, `pcp web fetch ${kind}`, key)
    : key
}

/** The keys a rule may be found by: its hash, or the site from before. */
export function ruleKeys(
  ctx: VaultContext,
  kind: string,
  key: string,
): string[] {
  return SEALED_KINDS.has(kind) ? [ruleKey(ctx, kind, key), key] : [key]
}

/** The key and sealed columns of a new row. */
export function sealedRuleKey(
  ctx: VaultContext,
  id: string,
  kind: string,
  key: string,
): { key: string; sealed: Sealed | null } {
  return SEALED_KINDS.has(kind)
    ? {
        key: ruleKey(ctx, kind, key),
        sealed: sealText(ctx.dek, aad(id), key),
      }
    : { key, sealed: null }
}

/** A row's key, opened: the site, the method, "private" or an exit's id. */
export function openRuleKey(
  ctx: VaultContext,
  row: { id: string; key: string; sealed: Uint8Array | null },
): string {
  return openText(ctx.dek, aad(row.id), row.sealed, row.key)
}

/**
 * Seals the rows from before at one site (`key`), in every scope, so an
 * upsert by the hash finds them. Nothing for kinds that are not sealed.
 */
export async function sealRuleRows(
  ctx: VaultContext,
  kind: string,
  key: string,
): Promise<void> {
  if (!SEALED_KINDS.has(kind)) {
    return
  }

  const rows = await db().webFetchRule.findMany({
    where: { vaultId: ctx.vaultId, kind, key, sealed: null },
    select: { id: true, updatedAt: true },
  })

  for (const row of rows) {
    await db().webFetchRule.update({
      where: { id: row.id },
      data: {
        ...sealedRuleKey(ctx, row.id, kind, key),
        updatedAt: row.updatedAt,
      },
    })
  }
}

/** Whether a rule of `kind` is keyed by a sealed site. */
export function isSealedKind(kind: string): boolean {
  return SEALED_KINDS.has(kind)
}
