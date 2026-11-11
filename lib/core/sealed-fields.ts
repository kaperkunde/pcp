import { decryptString } from "./crypto"
import { sealJson, type Sealed } from "./sealed"

/**
 * Several of a row's values sealed together (#96): one JSON object in one
 * column, AES-256-GCM under the vault's data key with
 * "<table>:<id>:<column>" as associated data. A row from before holds each
 * value in a plain column of its own (`plain<Key>`, renamed in the Prisma
 * client so the compiler finds every reader) and nothing sealed; a row
 * written since holds the sealed column and blanks ("" or null) in the
 * plain ones. Every reader goes through `openFields`, which takes either
 * form, so a vault half converted (lib/core/sealing/convert.ts) works as
 * one wholly converted does.
 */

export type PlainKey<K extends string> = `plain${Capitalize<K>}`

/** The group's values that have a plain column. */
function plainKeys(group: { blank: object; sealedOnly?: readonly string[] }) {
  return Object.keys(group.blank).filter(
    (key) => !group.sealedOnly?.includes(key),
  )
}

export function plainKey<K extends string>(key: K): PlainKey<K> {
  return `plain${key.charAt(0).toUpperCase()}${key.slice(1)}` as PlainKey<K>
}

export type SealedGroup<
  M extends Record<string, unknown>,
  C extends string,
  I extends string = "id",
> = {
  /** The column the sealed JSON is in. */
  column: C
  /** The column that names the row: its id, or the server it belongs to. */
  idKey: I
  /** The associated data, from that id. */
  aad: (id: string) => string
  /**
   * Each value's blank: what a sealed row's plain column holds, and what a
   * value missing from the JSON reads as.
   */
  blank: M
  /** Values that never had a plain column: read from the sealed JSON only. */
  sealedOnly?: ReadonlyArray<keyof M & string>
}

/** The columns a reader selects to read a group's values. */
export type GroupSelect<
  M extends Record<string, unknown>,
  C extends string,
  I extends string,
> = { [K in C | I | PlainKey<keyof M & string>]: true }

export function groupSelect<
  M extends Record<string, unknown>,
  C extends string,
  I extends string,
>(group: SealedGroup<M, C, I>): GroupSelect<M, C, I> {
  const select: Record<string, true> = {
    [group.column]: true,
    [group.idKey]: true,
  }

  for (const key of plainKeys(group)) {
    select[plainKey(key)] = true
  }

  return select as GroupSelect<M, C, I>
}

/** A row with a group's values opened under their own names. */
export type Opened<T, M extends Record<string, unknown>, C extends string> = {
  [K in keyof T as K extends C | PlainKey<keyof M & string> ? never : K]: T[K]
} & {
  [K in keyof M & string as PlainKey<K> extends keyof T ? K : never]: M[K]
}

/** What a row stores for the group's values: sealed, the plain columns blank. */
export function sealFields<
  M extends Record<string, unknown>,
  C extends string,
  I extends string,
>(
  dek: Buffer,
  group: SealedGroup<M, C, I>,
  id: string,
  values: M,
): { [K in C]: Sealed } & { [K in PlainKey<keyof M & string>]: unknown } {
  const stored: Record<string, unknown> = {}
  const sealed: Record<string, unknown> = {}

  for (const [key, blank] of Object.entries(group.blank)) {
    if (!group.sealedOnly?.includes(key)) {
      stored[plainKey(key)] = blank
    }
    sealed[key] = values[key] ?? blank
  }

  stored[group.column] = sealJson(dek, group.aad(id), sealed)
  return stored as { [K in C]: Sealed } & {
    [K in PlainKey<keyof M & string>]: unknown
  }
}

/**
 * Every value of the group from a row that selected all of them: the
 * sealed ones when there are, else the plain columns'.
 */
export function readFields<
  M extends Record<string, unknown>,
  C extends string,
  I extends string,
>(
  dek: Buffer,
  group: SealedGroup<M, C, I>,
  row: { [K in C]: Uint8Array | null } & { [K in I]: string } & {
    [K in PlainKey<keyof M & string>]: unknown
  },
): M {
  return openFields(dek, group, row as Record<string, unknown>) as M
}

/**
 * The values of the group whose plain column the row has. A row that
 * selected a plain column without the sealed one is a mistake of the
 * reader's, refused rather than read as blank.
 */
function openFields<
  M extends Record<string, unknown>,
  C extends string,
  I extends string,
>(
  dek: Buffer,
  group: SealedGroup<M, C, I>,
  row: Record<string, unknown>,
): Partial<M> {
  const plain = plainKeys(group).filter((key) => plainKey(key) in row)

  if (plain.length === 0) {
    return {}
  }

  const keys = [...plain, ...(group.sealedOnly ?? [])]

  if (!(group.column in row) || typeof row[group.idKey] !== "string") {
    throw new Error(
      `Select ${group.column} and ${group.idKey} to read ${keys.join(", ")}.`,
    )
  }

  const sealed = row[group.column] as Uint8Array | null
  const values: Record<string, unknown> = {}

  if (sealed) {
    const opened = JSON.parse(
      decryptString(
        dek,
        Buffer.from(sealed),
        group.aad(row[group.idKey] as string),
      ),
    ) as Record<string, unknown>

    for (const key of keys) {
      // A value sealed later than the rest (a short name, a tool's name)
      // is missing from JSON written before it was: its plain column still
      // holds it, until the row is sealed again.
      values[key] =
        key in opened
          ? (opened[key] ?? group.blank[key])
          : group.sealedOnly?.includes(key)
            ? group.blank[key]
            : (row[plainKey(key)] ?? group.blank[key])
    }
  } else {
    for (const key of keys) {
      values[key] = group.sealedOnly?.includes(key)
        ? group.blank[key]
        : row[plainKey(key)]
    }
  }

  return values as Partial<M>
}

/** A row with the group's values opened, the sealed and plain columns left out. */
export function openRow<
  T extends object,
  M extends Record<string, unknown>,
  C extends string,
  I extends string,
>(dek: Buffer, group: SealedGroup<M, C, I>, row: T): Opened<T, M, C> {
  const values = openFields(
    dek,
    group,
    row as unknown as Record<string, unknown>,
  )
  const rest: Record<string, unknown> = { ...(row as Record<string, unknown>) }

  delete rest[group.column]

  for (const key of plainKeys(group)) {
    delete rest[plainKey(key)]
  }

  return { ...rest, ...values } as unknown as Opened<T, M, C>
}
