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
import { sealingState } from "./state"

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

/**
 * One table's conversion: `read` finds up to `limit` rows from before and
 * answers a write for each, which seals that row and says whether it did.
 */
export type Converter = {
  table: string
  read: (
    ctx: VaultContext,
    limit: number,
  ) => Promise<Array<() => Promise<boolean>>>
}

function converter<Row>({
  table,
  read,
  write,
}: {
  table: string
  read: (ctx: VaultContext, limit: number) => Promise<Row[]>
  write: (ctx: VaultContext, row: Row) => Promise<boolean>
}): Converter {
  return {
    table,
    read: async (ctx, limit) =>
      (await read(ctx, limit)).map((row) => () => write(ctx, row)),
  }
}

export const SEAL_CONVERTERS: Converter[] = [
  converter({
    table: "setting",
    read: (ctx, limit) =>
      db().setting.findMany({
        where: {
          vaultId: ctx.vaultId,
          key: { notIn: [...PLAIN_SETTINGS] },
          NOT: { value: { startsWith: "pcp-sealed:" } },
        },
        take: limit,
      }),
    write: async (ctx, row) => {
      if (isSealedText(row.value)) {
        return false
      }

      await db().setting.update({
        where: { vaultId_key: { vaultId: row.vaultId, key: row.key } },
        data: { value: storedSetting(ctx, row.key, row.value) },
      })
      return true
    },
  }),
  converter({
    table: "secret",
    read: (ctx, limit) =>
      db().secret.findMany({
        where: { vaultId: ctx.vaultId, meta: null },
        select: {
          id: true,
          plainName: true,
          plainDescription: true,
          updatedAt: true,
        },
        take: limit,
      }),
    write: async (ctx, row) => {
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
      return true
    },
  }),
  converter({
    table: "api_token",
    read: (ctx, limit) =>
      db().apiToken.findMany({
        where: { vaultId: ctx.vaultId, sealedName: null },
        select: { id: true, plainName: true },
        take: limit,
      }),
    write: async (ctx, row) => {
      await db().apiToken.update({
        where: { id: row.id },
        data: sealedTokenName(ctx, row.id, row.plainName),
      })
      return true
    },
  }),
  converter({
    table: "secret_browser_origin",
    read: (ctx, limit) =>
      db().secretBrowserOrigin.findMany({
        where: { secret: { vaultId: ctx.vaultId }, sealed: null },
        take: limit,
      }),
    write: async (ctx, row) => {
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
            secretId_origin: { secretId: row.secretId, origin: sealed.origin },
          },
          create: { ...row, ...sealed },
          update: {},
        }),
      ])
      return true
    },
  }),
  converter({
    table: "api_token_site_allowance",
    read: (ctx, limit) =>
      db().apiTokenSiteAllowance.findMany({
        where: { token: { vaultId: ctx.vaultId }, sealed: null },
        take: limit,
      }),
    write: async (ctx, row) => {
      const sealed = sealedSiteAllowance(ctx, row.tokenId, row.host)
      await db().$transaction([
        db().apiTokenSiteAllowance.delete({
          where: { tokenId_host: { tokenId: row.tokenId, host: row.host } },
        }),
        db().apiTokenSiteAllowance.upsert({
          where: { tokenId_host: { tokenId: row.tokenId, host: sealed.host } },
          create: { ...row, ...sealed },
          update: {},
        }),
      ])
      return true
    },
  }),
  converter({
    table: "web_fetch_rule",
    read: (ctx, limit) =>
      db().webFetchRule.findMany({
        where: {
          vaultId: ctx.vaultId,
          kind: { in: ["site", "script"] },
          sealed: null,
        },
        select: { id: true, kind: true, key: true, updatedAt: true },
        take: limit,
      }),
    write: async (ctx, row) => {
      if (!isSealedKind(row.kind)) {
        return false
      }

      await db().webFetchRule.update({
        where: { id: row.id },
        data: {
          ...sealedRuleKey(ctx, row.id, row.kind, row.key),
          updatedAt: row.updatedAt,
        },
      })
      return true
    },
  }),
]

export { forgetSealedVaults } from "./state"

/**
 * One batch of the vault's conversion. Answers true once nothing is left
 * in plain text.
 */
export async function ensureSealed(
  ctx: VaultContext,
  {
    limit = SEAL_BATCH,
    converters = SEAL_CONVERTERS,
  }: { limit?: number; converters?: Converter[] } = {},
): Promise<boolean> {
  const { sealed, dirty } = sealingState()

  if (sealed.has(ctx.vaultId)) {
    return true
  }

  let left = false

  for (const converter of converters) {
    const writes = await converter.read(ctx, limit)
    let count = 0

    for (const write of writes) {
      if (await write()) {
        count++
      }
    }

    if (count > 0) {
      dirty.add(ctx.vaultId)
    }

    // A full batch may have more behind it.
    left ||= writes.length >= limit
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
