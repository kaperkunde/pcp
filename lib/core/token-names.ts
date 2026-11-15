import type { VaultContext } from "./context"
import { openText, sealText, type Sealed } from "./sealed"

/**
 * An API token's name, sealed under the vault's key as
 * "api_token:<id>:name" (#96). A row from before holds it in plain text
 * (plainName) and nothing sealed, until the vault's rows are sealed.
 */

/** The columns a reader selects to know a token's name. */
export const TOKEN_NAME_SELECT = {
  id: true,
  plainName: true,
  sealedName: true,
} as const

type NameRow = {
  id: string
  plainName: string
  sealedName: Uint8Array | null
}

function aad(id: string): string {
  return `api_token:${id}:name`
}

/** What a row stores for its name. */
export function sealedTokenName(
  ctx: VaultContext,
  id: string,
  name: string,
): { plainName: string; sealedName: Sealed } {
  return { plainName: "", sealedName: sealText(ctx.dek, aad(id), name) }
}

export function tokenName(ctx: VaultContext, row: NameRow): string {
  return openText(ctx.dek, aad(row.id), row.sealedName, row.plainName)
}
