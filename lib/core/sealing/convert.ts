import { scrubFreedPages } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { db } from "../db"
import { sealedSecretMeta } from "../secret-meta"
import { isSealedText } from "../sealed"
import { PLAIN_SETTINGS, storedSetting } from "../settings"

/**
 * Seals what a vault kept in plain text before its descriptive values were
 * sealed (#96): rows from an older PCP, or restored from an older export.
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
