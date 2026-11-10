import { scrubFreedPages } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { db } from "../db"
import { sealedSiteAllowance } from "../allowances"
import { sealedOrigin } from "../browser-secrets"
import { isSealedKind, sealedRuleKey } from "../fetch-rule-keys"
import { sealedSecretMeta } from "../secret-meta"
import { isSealedText } from "../sealed"
import { sealedTokenName } from "../token-names"
import { PLAIN_SETTINGS, storedSetting } from "../settings"

/**
 * Seals what a vault kept in plain text before its descriptive values were
 * sealed (#96): rows from an older PCP, or restored from an older export.
 * A linked file's name is not here: it is sealed under its link's key,
 * which PCP does not keep, and a link from before ends within a week.
 * Only a request holds the vault's key, so this runs inside one, after the
 * answer (`after()` from /mcp and the owner's pages), a bounded batch per
 * table per request; never on a timer. Every reader takes either form, so
 * a vault half converted works as one wholly converted does.
 *
 * Once a vault has nothing left in plain text, the database file is
 * rebuilt (scrubFreedPages), so the old values leave its free pages and
 * write-ahead log too.
 */

/** Rows each table converts per request. */
export const SEAL_BATCH = 200

type Converter = {
  table: string
  /** Seals up to `limit` rows; answers how many it sealed. */
  run: (ctx: VaultContext, limit: number) => Promise<number>
}

const CONVERTERS: Converter[] = [
  {
    table: "setting",
    run: async (ctx, limit) => {
      const rows = await db().setting.findMany({
        where: {
          vaultId: ctx.vaultId,
          key: { notIn: [...PLAIN_SETTINGS] },
          NOT: { value: { startsWith: "pcp-sealed:" } },
        },
        take: limit,
      })

      for (const row of rows) {
        if (isSealedText(row.value)) {
          continue
        }

        await db().setting.update({
          where: { vaultId_key: { vaultId: row.vaultId, key: row.key } },
          data: { value: storedSetting(ctx, row.key, row.value) },
        })
      }

      return rows.length
    },
  },
  {
    table: "secret",
    run: async (ctx, limit) => {
      const rows = await db().secret.findMany({
        where: { vaultId: ctx.vaultId, meta: null },
        select: {
          id: true,
          plainName: true,
          plainDescription: true,
          updatedAt: true,
        },
        take: limit,
      })

      for (const row of rows) {
        await db().secret.update({
          where: { id: row.id },
          data: {
            ...sealedSecretMeta(ctx, row.id, {
              name: row.plainName,
              description: row.plainDescription,
            }),
            // Sealing is no change of the owner's.
            updatedAt: row.updatedAt,
          },
        })
      }

      return rows.length
    },
  },
  {
    table: "api_token",
    run: async (ctx, limit) => {
      const rows = await db().apiToken.findMany({
        where: { vaultId: ctx.vaultId, sealedName: null },
        select: { id: true, plainName: true },
        take: limit,
      })

      for (const row of rows) {
        await db().apiToken.update({
          where: { id: row.id },
          data: sealedTokenName(ctx, row.id, row.plainName),
        })
      }

      return rows.length
    },
  },
  {
    table: "secret_browser_origin",
    run: async (ctx, limit) => {
      const rows = await db().secretBrowserOrigin.findMany({
        where: { secret: { vaultId: ctx.vaultId }, sealed: null },
        take: limit,
      })

      for (const row of rows) {
        const sealed = sealedOrigin(ctx, row.secretId, row.origin)
        // The origin is part of the row's key: the sealed row replaces it.
        await db().$transaction([
          db().secretBrowserOrigin.delete({
            where: {
              secretId_origin: { secretId: row.secretId, origin: row.origin },
            },
          }),
          db().secretBrowserOrigin.upsert({
            where: {
              secretId_origin: {
                secretId: row.secretId,
                origin: sealed.origin,
              },
            },
            create: { ...row, ...sealed },
            update: {},
          }),
        ])
      }

      return rows.length
    },
  },
  {
    table: "api_token_site_allowance",
    run: async (ctx, limit) => {
      const rows = await db().apiTokenSiteAllowance.findMany({
        where: { token: { vaultId: ctx.vaultId }, sealed: null },
        take: limit,
      })

      for (const row of rows) {
        const sealed = sealedSiteAllowance(ctx, row.tokenId, row.host)
        await db().$transaction([
          db().apiTokenSiteAllowance.delete({
            where: { tokenId_host: { tokenId: row.tokenId, host: row.host } },
          }),
          db().apiTokenSiteAllowance.upsert({
            where: {
              tokenId_host: { tokenId: row.tokenId, host: sealed.host },
            },
            create: { ...row, ...sealed },
            update: {},
          }),
        ])
      }

      return rows.length
    },
  },
  {
    table: "web_fetch_rule",
    run: async (ctx, limit) => {
      const rows = await db().webFetchRule.findMany({
        where: {
          vaultId: ctx.vaultId,
          kind: { in: ["site", "script"] },
          sealed: null,
        },
        select: { id: true, kind: true, key: true, updatedAt: true },
        take: limit,
      })

      for (const row of rows) {
        if (!isSealedKind(row.kind)) {
          continue
        }

        await db().webFetchRule.update({
          where: { id: row.id },
          data: {
            ...sealedRuleKey(ctx, row.id, row.kind, row.key),
            updatedAt: row.updatedAt,
          },
        })
      }

      return rows.length
    },
  },
]

const STATE = Symbol.for("pcp.sealed-vaults")

type State = {
  /** Vaults this process found with nothing left to seal. */
  sealed: Set<string>
  /** Vaults this process sealed rows of, whose file is not rebuilt yet. */
  dirty: Set<string>
}

function state(): State {
  const holder = globalThis as unknown as { [STATE]?: State }
  holder[STATE] ??= { sealed: new Set(), dirty: new Set() }
  return holder[STATE]
}

/** Tests: forget which vaults were found sealed. */
export function forgetSealedVaults(): void {
  state().sealed.clear()
  state().dirty.clear()
}

/**
 * One batch of the vault's conversion. Answers true once nothing is left
 * in plain text.
 */
export async function ensureSealed(
  ctx: VaultContext,
  { limit = SEAL_BATCH }: { limit?: number } = {},
): Promise<boolean> {
  const { sealed, dirty } = state()

  if (sealed.has(ctx.vaultId)) {
    return true
  }

  let left = false

  for (const converter of CONVERTERS) {
    const count = await converter.run(ctx, limit)

    if (count > 0) {
      dirty.add(ctx.vaultId)
    }

    // A full batch may have more behind it.
    left ||= count >= limit
  }

  if (left) {
    return false
  }

  sealed.add(ctx.vaultId)

  if (dirty.delete(ctx.vaultId)) {
    // The plain values are gone from the rows; the file's free pages and
    // its log still hold them until it is rebuilt.
    await scrubFreedPages({ rebuild: true })
  }

  return true
}
