import type { Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { keyedHash } from "./keyed-hash"
import { openJson, sealJson, type Sealed } from "./sealed"

/**
 * A secret's name and description, sealed (#96): JSON under the vault's
 * key as "secret:<id>:meta", the name found by a keyed hash (`name_key`,
 * unique in the vault). A row from before holds them in its plain columns
 * and no meta until the vault's rows are converted
 * (lib/core/sealing/convert.ts); every reader here takes either form.
 * Never the value: that is secrets.ts's alone.
 */

const NAME_LABEL = "secret name"

export type SecretMeta = { name: string; description: string }

/** The columns a reader selects to know a secret's name. */
export const SECRET_META_SELECT = {
  id: true,
  meta: true,
  plainName: true,
  plainDescription: true,
} as const

type MetaRow = {
  id: string
  meta: Uint8Array | null
  plainName: string
  plainDescription: string
}

function aad(id: string): string {
  return `secret:${id}:meta`
}

export function secretNameKey(ctx: VaultContext, name: string): string {
  return keyedHash(ctx.dek, NAME_LABEL, name)
}

/** What a row stores for its name and description. */
export function sealedSecretMeta(
  ctx: VaultContext,
  id: string,
  meta: SecretMeta,
): {
  meta: Sealed
  nameKey: string
  plainName: string
  plainDescription: string
} {
  return {
    meta: sealJson(ctx.dek, aad(id), meta),
    nameKey: secretNameKey(ctx, meta.name),
    plainName: "",
    plainDescription: "",
  }
}

export function openSecretMeta(ctx: VaultContext, row: MetaRow): SecretMeta {
  const sealed = openJson<SecretMeta>(ctx.dek, aad(row.id), row.meta)

  return sealed ?? { name: row.plainName, description: row.plainDescription }
}

export function secretName(ctx: VaultContext, row: MetaRow): string {
  return openSecretMeta(ctx, row).name
}

/** A row with its name and description opened, the sealed columns left out. */
export function withSecretMeta<T extends MetaRow>(
  ctx: VaultContext,
  row: T,
): Omit<T, "meta" | "plainName" | "plainDescription"> & SecretMeta {
  const { meta: _meta, plainName: _n, plainDescription: _d, ...rest } = row
  return { ...rest, ...openSecretMeta(ctx, row) }
}

/** The vault's secrets named `name`: by its hash, or a row from before. */
export function secretNameWhere(
  ctx: VaultContext,
  name: string,
): Prisma.SecretWhereInput {
  return secretNamesWhere(ctx, [name])
}

export function secretNamesWhere(
  ctx: VaultContext,
  names: readonly string[],
): Prisma.SecretWhereInput {
  return {
    vaultId: ctx.vaultId,
    OR: [
      { nameKey: { in: names.map((name) => secretNameKey(ctx, name)) } },
      { nameKey: null, plainName: { in: [...names] } },
    ],
  }
}

/** By name, as the owner reads a list. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
