import type { VaultContext } from "./context"
import { keyedHash } from "./crypto"
import { openText, sealText, type Sealed } from "./sealed"

/**
 * A tool's name on a row of the owner's levels, allowances, tiers and
 * requests (#96): the column that held it holds a keyed hash under the
 * vault's key, bound to the server (or the definition) it is for, so two
 * servers' tools of one name hash apart and a lookup or a unique key still
 * works; the name itself is sealed beside it, as
 * "<table>:<owner>:<hash>" (the row's own key, so it opens only where it
 * was written). A row from before holds the name in plain text and nothing
 * sealed, until the vault's rows are converted
 * (lib/core/sealing/convert.ts); every reader takes either.
 *
 * Nothing that runs without the vault's key needs a name: the cleanup
 * deletes by date, and everything else holds a request's context.
 */

export type LevelTable =
  | "api_token_tool_access"
  | "api_token_tool_allowance"
  | "vault_tool_access"
  | "tool_tier"
  | "permission_request"

const LABEL = "pcp tool level"

/** The hash a tool's name is kept as, for what it is for (a server, a definition). */
export function levelNameKey(
  ctx: VaultContext,
  scopeId: string,
  name: string,
): string {
  return keyedHash(ctx.dek, LABEL, `${scopeId}\n${name}`)
}

function levelNameAad(table: LevelTable, owner: string, key: string): string {
  return `${table}:${owner}:${key}`
}

/**
 * What a row stores for a tool's name: the hash, and the name sealed.
 * `owner` is what the row is bound to besides the hash (a token and a
 * server, a server, the row's id).
 */
export function sealedLevelName(
  ctx: VaultContext,
  table: LevelTable,
  owner: string,
  scopeId: string,
  name: string,
): { key: string; sealed: Sealed } {
  const key = levelNameKey(ctx, scopeId, name)
  return {
    key,
    sealed: sealText(ctx.dek, levelNameAad(table, owner, key), name),
  }
}

/** A row's tool name: opened when sealed, as it stands when from before. */
export function openLevelName(
  ctx: VaultContext,
  table: LevelTable,
  owner: string,
  row: { key: string; sealed: Uint8Array | null },
): string {
  return openText(
    ctx.dek,
    levelNameAad(table, owner, row.key),
    row.sealed,
    row.key,
  )
}

/** The values a name may be stored as: its hash, or itself from before. */
export function levelNameKeys(
  ctx: VaultContext,
  scopeId: string,
  name: string,
): string[] {
  return [levelNameKey(ctx, scopeId, name), name]
}

/** The tool a permission request is for, from the row as stored. */
export function openRequestTool(
  ctx: VaultContext,
  row: { id: string; toolName: string; toolSealed: Uint8Array | null },
): string {
  return openLevelName(ctx, "permission_request", `${row.id}:tool`, {
    key: row.toolName,
    sealed: row.toolSealed,
  })
}
