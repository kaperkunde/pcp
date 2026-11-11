import type { McpServer, Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { keyedHash } from "./crypto"
import { db } from "./db"
import { notFound, PcpError } from "./errors"
import {
  groupSelect,
  type Opened,
  openRow,
  type PlainKey,
  readFields,
  sealFields,
  type SealedGroup,
} from "./sealed-fields"

/**
 * What a server is and where it is (#96): its name, short name (`slug`),
 * description and address, the logins and accounts it signs in with, what
 * PCP found out of it (its mail and calendar addresses, its SSH keys) and
 * what its status says, sealed as one JSON object in `meta` under the
 * vault's key as "mcp_server:<id>:meta" ("mcp_server:<id>" is the owner's
 * note). The short name is found by its keyed hash (`slugKey`, unique in
 * the vault): a lookup by name hashes the name it is given
 * (serverSlugWhere). Ids, the kind, flags and the status word stay plain.
 *
 * A row from before holds them in their plain columns (plainName,
 * plainUrl, …) and nothing in meta, until the vault's rows are converted
 * (lib/core/sealing/convert.ts). Every reader opens a row with openServer,
 * which takes either form; every writer of these values goes through
 * serverCreateData or writeServer, which seal them.
 */

export type ServerMeta = {
  name: string
  slug: string
  description: string
  url: string
  statusMessage: string
  authUsername: string | null
  oauthClientId: string | null
  oauthScope: string | null
  oauthAuthorizeParams: string | null
  oauthAuthorizationUrl: string | null
  oauthTokenUrl: string | null
  specUrl: string | null
  mailApiUrl: string | null
  mailDownloadUrl: string | null
  mailUploadUrl: string | null
  mailAccountId: string | null
  smtpUrl: string | null
  mailFrom: string | null
  sshPublicKey: string | null
  sshHostKey: string | null
  davHomeUrl: string | null
}

export type ServerMetaKey = keyof ServerMeta

const BLANK: ServerMeta = {
  name: "",
  slug: "",
  description: "",
  url: "",
  statusMessage: "",
  authUsername: null,
  oauthClientId: null,
  oauthScope: null,
  oauthAuthorizeParams: null,
  oauthAuthorizationUrl: null,
  oauthTokenUrl: null,
  specUrl: null,
  mailApiUrl: null,
  mailDownloadUrl: null,
  mailUploadUrl: null,
  mailAccountId: null,
  smtpUrl: null,
  mailFrom: null,
  sshPublicKey: null,
  sshHostKey: null,
  davHomeUrl: null,
}

export const SERVER_META_KEYS = Object.keys(BLANK) as ServerMetaKey[]

export const SERVER_META: SealedGroup<ServerMeta, "meta"> = {
  column: "meta",
  idKey: "id",
  aad: (id) => `mcp_server:${id}:meta`,
  blank: BLANK,
}

/** The columns a reader selects to read every sealed value of a server. */
export const SERVER_META_SELECT = groupSelect(SERVER_META)

/** The columns the owner's pages and most readers take: name and kind. */
export const SERVER_NAME_SELECT = {
  ...SERVER_META_SELECT,
  kind: true,
} as const

const SLUG_LABEL = "pcp server slug"

/** A short name's keyed hash under the vault's key: what slugKey holds. */
export function serverSlugKey(ctx: VaultContext, slug: string): string {
  return keyedHash(ctx.dek, SLUG_LABEL, slug)
}

/**
 * The vault's servers with one of these short names: by its hash, or a
 * row from before that holds it in plain text.
 */
export function serverSlugsWhere(
  ctx: VaultContext,
  slugs: readonly string[],
): Prisma.McpServerWhereInput {
  return {
    vaultId: ctx.vaultId,
    AND: [
      {
        OR: [
          { slugKey: { in: slugs.map((slug) => serverSlugKey(ctx, slug)) } },
          { slugKey: null, plainSlug: { in: [...slugs] } },
        ],
      },
    ],
  }
}

/** The vault's server with this short name, as serverSlugsWhere. */
export function serverSlugWhere(
  ctx: VaultContext,
  slug: string,
): Prisma.McpServerWhereInput {
  return serverSlugsWhere(ctx, [slug])
}

/** The vault's server with this short name, opened. */
export async function findServerBySlug(
  ctx: VaultContext,
  slug: string,
  client: Client = db(),
): Promise<OpenServer | null> {
  return findServer(ctx, serverSlugWhere(ctx, slug), client)
}

/** Whether another server of the vault has this short name. */
export async function serverSlugTaken(
  ctx: VaultContext,
  slug: string,
  exceptId?: string,
  client: Client = db(),
): Promise<boolean> {
  const clash = await client.mcpServer.findFirst({
    where: {
      ...serverSlugWhere(ctx, slug),
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  })
  return clash !== null
}

type PlainServerKey = PlainKey<ServerMetaKey>

/** A whole server row, its sealed values opened under their own names. */
export type OpenServer = Opened<McpServer, ServerMeta, "meta">

/** A row (whole or selected) with its sealed values opened. */
export function openServer<T extends { id: string; meta: Uint8Array | null }>(
  ctx: VaultContext,
  row: T,
): Opened<T, ServerMeta, "meta"> {
  return openRow(ctx.dek, SERVER_META, row)
}

/** Each row opened, as openServer. */
export function openServers<T extends { id: string; meta: Uint8Array | null }>(
  ctx: VaultContext,
  rows: T[],
): Array<Opened<T, ServerMeta, "meta">> {
  return rows.map((row) => openServer(ctx, row))
}

/** A server's name, from a row that selected SERVER_META_SELECT. */
export function serverName(
  ctx: VaultContext,
  row: Parameters<typeof readFields<ServerMeta, "meta", "id">>[2],
): string {
  return readFields(ctx.dek, SERVER_META, row).name
}

/** A server's short name, from a row that selected SERVER_META_SELECT. */
export function serverSlug(
  ctx: VaultContext,
  row: Parameters<typeof readFields<ServerMeta, "meta", "id">>[2],
): string {
  return readFields(ctx.dek, SERVER_META, row).slug
}

/** By name, as the owner reads a list; the order a query once gave. */
export function byServerName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** By short name: the order a query once gave, kept in memory now (#96). */
export function byServerSlug<T extends { slug: string }>(a: T, b: T): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
}

type Client = Prisma.TransactionClient | ReturnType<typeof db>

/** Values that are a server's sealed ones, and the rest. */
function split<T extends Record<string, unknown>>(
  data: T,
): { meta: Partial<ServerMeta>; rest: Omit<T, ServerMetaKey> } {
  const meta: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue
    }

    if ((SERVER_META_KEYS as string[]).includes(key)) {
      meta[key] = value
    } else {
      rest[key] = value
    }
  }

  return {
    meta: meta as Partial<ServerMeta>,
    rest: rest as Omit<T, ServerMetaKey>,
  }
}

type NoPlain<T> = Omit<T, "meta" | PlainServerKey>

/** What a sealed row holds in its plain columns, and in meta. */
type SealedColumns = { meta: Uint8Array<ArrayBuffer>; slugKey: string } & {
  [K in ServerMetaKey as PlainKey<K>]: ServerMeta[K]
}

/** What a row stores for its sealed values: meta, the slug's hash, blanks. */
function sealedColumns(
  ctx: VaultContext,
  id: string,
  meta: ServerMeta,
): SealedColumns {
  return {
    ...(sealFields(ctx.dek, SERVER_META, id, meta) as Omit<
      SealedColumns,
      "slugKey"
    >),
    slugKey: serverSlugKey(ctx, meta.slug),
  }
}

/** What a new server row stores: its sealed values sealed, the rest as given. */
export function serverCreateData<
  T extends { id: string } & Partial<ServerMeta> &
    Pick<ServerMeta, "name" | "url" | "slug">,
>(ctx: VaultContext, data: T): NoPlain<Omit<T, ServerMetaKey>> & SealedColumns {
  const { meta, rest } = split(data)

  return {
    ...rest,
    ...sealedColumns(ctx, data.id, { ...BLANK, ...meta }),
  }
}

/** A change to a server row: any of its columns, its sealed values by name. */
export type ServerWrite = Omit<
  Prisma.McpServerUncheckedUpdateInput,
  "meta" | PlainServerKey | "id" | "slugKey"
> &
  Partial<ServerMeta>

/**
 * Writes a change to a server, sealing the values among it that are
 * sealed. Those are one JSON object, so a change to some reads the others
 * and writes them back only over what it read: a write that came between
 * is read again, never lost. A row from before is sealed whole by its
 * first such write.
 */
export async function writeServer(
  ctx: VaultContext,
  id: string,
  data: ServerWrite,
  client: Client = db(),
): Promise<void> {
  const { meta, rest } = split(data as Record<string, unknown>)

  if (Object.keys(meta).length > 0) {
    await writeMeta(ctx, id, meta, client)
  }

  if (Object.keys(rest).length > 0) {
    await client.mcpServer.update({
      where: { id },
      data: rest as Prisma.McpServerUncheckedUpdateInput,
    })
  }
}

/** writeServer, answering the row as it is now, opened. */
export async function updateServerRow(
  ctx: VaultContext,
  id: string,
  data: ServerWrite,
  client: Client = db(),
): Promise<OpenServer> {
  await writeServer(ctx, id, data, client)
  return openServer(
    ctx,
    await client.mcpServer.findUniqueOrThrow({ where: { id } }),
  )
}

/** Writes over a conflicting write this many times before giving up. */
const META_ATTEMPTS = 8

async function writeMeta(
  ctx: VaultContext,
  id: string,
  patch: Partial<ServerMeta>,
  client: Client,
): Promise<void> {
  for (let attempt = 0; attempt < META_ATTEMPTS; attempt++) {
    const row = await client.mcpServer.findUnique({
      where: { id },
      select: SERVER_META_SELECT,
    })

    if (!row) {
      throw notFound("That server")
    }

    const next = { ...readFields(ctx.dek, SERVER_META, row), ...patch }
    const { count } = await client.mcpServer.updateMany({
      where: { id, meta: row.meta === null ? null : { equals: row.meta } },
      data: sealedColumns(ctx, id, next) as Omit<
        Prisma.McpServerUncheckedUpdateManyInput,
        "id"
      >,
    })

    if (count === 1) {
      return
    }
  }

  throw new PcpError(
    "conflict",
    "The server changed while this was saved; try again.",
  )
}

/** What a server row stores for its values sealed whole: the conversion. */
export function sealedServerMeta(
  ctx: VaultContext,
  id: string,
  meta: ServerMeta,
): Omit<Prisma.McpServerUncheckedUpdateManyInput, "id"> {
  return sealedColumns(ctx, id, meta) as Omit<
    Prisma.McpServerUncheckedUpdateManyInput,
    "id"
  >
}

/** Every sealed value of a row that selected SERVER_META_SELECT, either form. */
export function readServerMeta(
  ctx: VaultContext,
  row: Parameters<typeof readFields<ServerMeta, "meta", "id">>[2],
): ServerMeta {
  return readFields(ctx.dek, SERVER_META, row)
}

/** The first server row the query finds, opened. */
export async function findServer(
  ctx: VaultContext,
  where: Prisma.McpServerWhereInput,
  client: Client = db(),
): Promise<OpenServer | null> {
  const row = await client.mcpServer.findFirst({ where })
  return row ? openServer(ctx, row) : null
}

/** The server rows the query finds, opened, oldest first. */
export async function findServers(
  ctx: VaultContext,
  where: Prisma.McpServerWhereInput,
  client: Client = db(),
): Promise<OpenServer[]> {
  return openServers(
    ctx,
    await client.mcpServer.findMany({ where, orderBy: { createdAt: "asc" } }),
  )
}
