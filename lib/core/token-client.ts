import type { VaultContext } from "./context"
import { db } from "./db"
import { readFields, sealFields, type SealedGroup } from "./sealed-fields"

/**
 * What PCP knows of the app a token is for, sealed (#96): the name the app
 * gave when it signed in with OAuth, and the client PCP last saw use the
 * token (a JSON record), as one JSON under the vault's key as
 * "api_token:<id>:client". A row from before holds them in plain columns and
 * nothing sealed, until it is converted. `oauth_client_id` stays plain: the
 * token endpoint compares it before any key is held.
 */
export type TokenClientValues = {
  oauthClientName: string | null
  clientSeen: string | null
}

export const TOKEN_CLIENT: SealedGroup<TokenClientValues, "clientMeta"> = {
  column: "clientMeta",
  idKey: "id",
  aad: (id) => `api_token:${id}:client`,
  blank: { oauthClientName: null, clientSeen: null },
}

/** What a token row stores for these values. */
export function sealedTokenClient(
  ctx: VaultContext,
  id: string,
  values: TokenClientValues,
) {
  return sealFields(ctx.dek, TOKEN_CLIENT, id, values) as {
    clientMeta: Uint8Array<ArrayBuffer>
    plainOauthClientName: null
    plainClientSeen: null
  }
}

/** The values of a row that selected them (and its id). */
export function readTokenClient(
  ctx: VaultContext,
  row: Parameters<typeof readFields<TokenClientValues, "clientMeta", "id">>[2],
): TokenClientValues {
  return readFields(ctx.dek, TOKEN_CLIENT, row)
}

/**
 * Changes some of them: the others are read and written back in one
 * transaction, so a write between is never lost.
 */
export async function writeTokenClient(
  ctx: VaultContext,
  id: string,
  patch: Partial<TokenClientValues>,
): Promise<void> {
  await db().$transaction(async (tx) => {
    const row = await tx.apiToken.findFirst({
      where: { id, vaultId: ctx.vaultId },
      select: {
        id: true,
        clientMeta: true,
        plainOauthClientName: true,
        plainClientSeen: true,
      },
    })

    if (!row) {
      return
    }

    await tx.apiToken.update({
      where: { id },
      data: sealedTokenClient(ctx, id, {
        ...readTokenClient(ctx, row),
        ...patch,
      }),
    })
  })
}
