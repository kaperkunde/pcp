import { scrubFreedPages } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { db } from "../db"
import { sealedSiteAllowance } from "../allowances"
import { sealedAllowanceOrigin, sealedOrigin } from "../browser-secrets"
import { isSealedKind, sealedRuleKey } from "../fetch-rule-keys"
import { sealedSecretMeta } from "../secret-meta"
import { isSealedText } from "../sealed"
import { sealedTokenName } from "../token-names"
import { sealedResultName } from "../tool-results"
import {
  plainServerMeta,
  sealedServerMeta,
  SERVER_META_SELECT,
} from "../server-meta"
import { sealedDefinitionMeta } from "../definition-rows"
import {
  plainToolValues,
  sealedToolContent,
  sealedToolOverride,
} from "../tool-rows"
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

      // Only over the value it read: one the owner saved since stays.
      const { count } = await db().setting.updateMany({
        where: { vaultId: row.vaultId, key: row.key, value: row.value },
        data: { value: storedSetting(ctx, row.key, row.value) },
      })
      return count === 1
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
      // Only a row still as it was read: a name the owner gave it since
      // is sealed already, and stays.
      const { count } = await db().secret.updateMany({
        where: {
          id: row.id,
          meta: null,
          plainName: row.plainName,
          plainDescription: row.plainDescription,
        },
        data: {
          ...sealedSecretMeta(ctx, row.id, {
            name: row.plainName,
            description: row.plainDescription,
          }),
          // Sealing is no change of the owner's.
          updatedAt: row.updatedAt,
        },
      })
      return count === 1
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
      const { count } = await db().apiToken.updateMany({
        where: { id: row.id, sealedName: null, plainName: row.plainName },
        data: sealedTokenName(ctx, row.id, row.plainName),
      })
      return count === 1
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
      // The origin is part of the row's key: the sealed row replaces it,
      // only if the plain one is still there.
      return db().$transaction(async (tx) => {
        const { count } = await tx.secretBrowserOrigin.deleteMany({
          where: { secretId: row.secretId, origin: row.origin, sealed: null },
        })

        if (count === 0) {
          return false
        }

        await tx.secretBrowserOrigin.upsert({
          where: {
            secretId_origin: { secretId: row.secretId, origin: sealed.origin },
          },
          create: { ...row, ...sealed },
          update: {},
        })
        return true
      })
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
      return db().$transaction(async (tx) => {
        const { count } = await tx.apiTokenSiteAllowance.deleteMany({
          where: { tokenId: row.tokenId, host: row.host, sealed: null },
        })

        if (count === 0) {
          return false
        }

        await tx.apiTokenSiteAllowance.upsert({
          where: { tokenId_host: { tokenId: row.tokenId, host: sealed.host } },
          create: { ...row, ...sealed },
          update: {},
        })
        return true
      })
    },
  }),
  converter({
    table: "api_token_secret_allowance",
    read: (ctx, limit) =>
      db().apiTokenSecretAllowance.findMany({
        where: { token: { vaultId: ctx.vaultId }, sealed: null },
        take: limit,
      }),
    write: async (ctx, row) => {
      const sealed = sealedAllowanceOrigin(
        ctx,
        row.tokenId,
        row.secretId,
        row.origin,
      )
      return db().$transaction(async (tx) => {
        const { count } = await tx.apiTokenSecretAllowance.deleteMany({
          where: {
            tokenId: row.tokenId,
            secretId: row.secretId,
            origin: row.origin,
            sealed: null,
          },
        })

        if (count === 0) {
          return false
        }

        await tx.apiTokenSecretAllowance.upsert({
          where: {
            tokenId_secretId_origin: {
              tokenId: row.tokenId,
              secretId: row.secretId,
              origin: sealed.origin,
            },
          },
          create: { ...row, ...sealed },
          update: {},
        })
        return true
      })
    },
  }),
  converter({
    table: "tool_result",
    read: (ctx, limit) =>
      db().toolResult.findMany({
        where: { vaultId: ctx.vaultId, plainName: { not: null } },
        select: { id: true, plainName: true },
        take: limit,
      }),
    write: async (ctx, row) => {
      const { count } = await db().toolResult.updateMany({
        where: { id: row.id, plainName: row.plainName },
        data: sealedResultName(ctx, row.id, row.plainName),
      })
      return count === 1
    },
  }),
  converter({
    table: "mcp_server",
    read: (ctx, limit) =>
      db().mcpServer.findMany({
        where: { vaultId: ctx.vaultId, meta: null },
        select: { ...SERVER_META_SELECT, updatedAt: true },
        take: limit,
      }),
    write: async (ctx, row) => {
      // Every write of these values since seals the whole row, so a row
      // still without meta is still as it was read.
      const { count } = await db().mcpServer.updateMany({
        where: { id: row.id, meta: null },
        data: {
          ...sealedServerMeta(ctx, row.id, plainServerMeta(row)),
          updatedAt: row.updatedAt,
        },
      })
      return count === 1
    },
  }),
  converter({
    table: "server_definition",
    read: (ctx, limit) =>
      db().serverDefinition.findMany({
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
      const { count } = await db().serverDefinition.updateMany({
        where: {
          id: row.id,
          meta: null,
          plainName: row.plainName,
          plainDescription: row.plainDescription,
        },
        data: {
          ...sealedDefinitionMeta(ctx, row.id, {
            name: row.plainName,
            description: row.plainDescription,
          }),
          updatedAt: row.updatedAt,
        },
      })
      return count === 1
    },
  }),
  converter({
    table: "mcp_tool",
    read: (ctx, limit) =>
      db().mcpTool.findMany({
        where: {
          server: { vaultId: ctx.vaultId },
          OR: [{ about: null }, { schema: null }, { override: null }],
        },
        take: limit,
      }),
    write: async (ctx, row) => {
      const values = plainToolValues(row)
      let sealed = false

      // Each part only while it is still from before: a read of the tools
      // since seals what it wrote, and the owner's wording is theirs.
      if (row.about === null || row.schema === null) {
        const { count } = await db().mcpTool.updateMany({
          where: { id: row.id, about: null, schema: null },
          data: {
            ...sealedToolContent(ctx, row.id, values),
            updatedAt: row.updatedAt,
          },
        })
        sealed ||= count === 1
      }

      if (row.override === null) {
        const { count } = await db().mcpTool.updateMany({
          where: {
            id: row.id,
            override: null,
            plainDescriptionOverride: row.plainDescriptionOverride,
          },
          data: {
            ...sealedToolOverride(ctx, row.id, values.descriptionOverride),
            updatedAt: row.updatedAt,
          },
        })
        sealed ||= count === 1
      }

      return sealed
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

      const { count } = await db().webFetchRule.updateMany({
        where: { id: row.id, sealed: null, key: row.key },
        data: {
          ...sealedRuleKey(ctx, row.id, row.kind, row.key),
          updatedAt: row.updatedAt,
        },
      })
      return count === 1
    },
  }),
]

export { forgetSealedVaults } from "./state"

/**
 * One batch of the vault's conversion. Answers true once nothing is left
 * in plain text. One at a time per vault: a call while one runs gets its
 * answer. A table that fails is left for the next request, said in the
 * log by its name only, and keeps no other table or the rebuild from
 * going on.
 */
export function ensureSealed(
  ctx: VaultContext,
  options: { limit?: number; converters?: Converter[] } = {},
): Promise<boolean> {
  const { running } = sealingState()
  const under = running.get(ctx.vaultId)

  if (under) {
    return under
  }

  const run = sealBatch(ctx, options).finally(() => {
    running.delete(ctx.vaultId)
  })
  running.set(ctx.vaultId, run)
  return run
}

async function sealBatch(
  ctx: VaultContext,
  {
    limit = SEAL_BATCH,
    converters = SEAL_CONVERTERS,
  }: { limit?: number; converters?: Converter[] },
): Promise<boolean> {
  const { sealed, dirty } = sealingState()

  if (sealed.has(ctx.vaultId)) {
    return true
  }

  let left = false
  let failed = false

  for (const converter of converters) {
    try {
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
    } catch {
      // What failed may hold the very values being sealed: the table only.
      console.error(`[sealing] could not seal the rows of ${converter.table}`)
      failed = true
    }
  }

  if (left) {
    return false
  }

  if (dirty.delete(ctx.vaultId)) {
    // The plain values are gone from the rows; the file's free pages and
    // its log still hold them until it is rebuilt.
    await scrubFreedPages({ rebuild: true })
  }

  if (failed) {
    return false
  }

  sealed.add(ctx.vaultId)
  return true
}
