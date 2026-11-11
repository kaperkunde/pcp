import type { Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import {
  groupSelect,
  openRow,
  readFields,
  sealFields,
  type SealedGroup,
} from "./sealed-fields"
import {
  openServer,
  openServers,
  type OpenServer,
  SERVER_META_SELECT,
  writeServer,
} from "./server-meta"
import { toolOverrides, writeToolOverride } from "./tool-rows"

/**
 * The rows behind definitions and instances (lib/core/definitions.ts has the
 * owner's operations on them): finding a server's definition and the other
 * servers that share it, making one for a server that has none, and keeping
 * what they share the same on every instance.
 *
 * What instances share is held on each of them, as before definitions
 * existed: the description on the server row, the schema and its edits in
 * openapi_spec, a wrapper's program in wrapper_spec, the tool descriptions
 * on mcp_tool, a service's in service_spec. Everything that reads a server reads one row as it always
 * did. Everything that writes shared content writes it through here (or
 * the endpoint and wrapper code that calls these), so a change made through
 * one instance reaches every other, and the definition row's description is
 * the instances'.
 */

/** The kinds of server that have a definition. */
export const DEFINITION_KINDS = [
  "mcp",
  "openapi",
  "wrapper",
  "service",
] as const
export type DefinitionKind = (typeof DEFINITION_KINDS)[number]

export function hasDefinition(kind: string): kind is DefinitionKind {
  return (DEFINITION_KINDS as readonly string[]).includes(kind)
}

type Client = Prisma.TransactionClient | ReturnType<typeof db>

/**
 * A definition's name and description, sealed (#96) as JSON in `meta`
 * under the vault's key as "server_definition:<id>:meta". A row from
 * before holds them in plainName and plainDescription until the vault's
 * rows are sealed (lib/core/sealing/convert.ts).
 */
export type DefinitionMeta = { name: string; description: string }

export const DEFINITION_META: SealedGroup<DefinitionMeta, "meta"> = {
  column: "meta",
  idKey: "id",
  aad: (id) => `server_definition:${id}:meta`,
  blank: { name: "", description: "" },
}

export const DEFINITION_META_SELECT = groupSelect(DEFINITION_META)

/** A definition row (whole or selected) with its name and description opened. */
export function openDefinition<
  T extends { id: string; meta: Uint8Array | null },
>(ctx: VaultContext, row: T) {
  return openRow(ctx.dek, DEFINITION_META, row)
}

/** A definition's name and description, from a row that selected them. */
export function definitionMeta(
  ctx: VaultContext,
  row: Parameters<typeof readFields<DefinitionMeta, "meta", "id">>[2],
): DefinitionMeta {
  return readFields(ctx.dek, DEFINITION_META, row)
}

/** What a definition row stores for its name and description. */
export function sealedDefinitionMeta(
  ctx: VaultContext,
  id: string,
  meta: DefinitionMeta,
): {
  meta: Uint8Array<ArrayBuffer>
  plainName: string
  plainDescription: string
} {
  return sealFields(ctx.dek, DEFINITION_META, id, meta) as {
    meta: Uint8Array<ArrayBuffer>
    plainName: string
    plainDescription: string
  }
}

/** A definition slug no other definition in the vault has. */
export async function uniqueDefinitionSlug(
  client: Client,
  vaultId: string,
  base: string,
  exceptId?: string,
): Promise<string> {
  const start = base || "server"
  let slug = start

  for (let n = 2; ; n++) {
    const clash = await client.serverDefinition.findUnique({
      where: { vaultId_slug: { vaultId, slug } },
      select: { id: true },
    })

    if (!clash || clash.id === exceptId) {
      return slug
    }

    slug = `${start}-${n}`
  }
}

/**
 * A definition of its own for a server, named after it, and the server
 * pointed at it. `id` is the definition's id: a restore uses the server's,
 * as the migration that made the first ones did.
 */
export async function newDefinitionFor(
  /**
   * The vault's key, to seal the name and description; null in a restore
   * that holds none, of a server from before (whose name is in plain text
   * already, until the vault's rows are sealed).
   */
  ctx: VaultContext | null,
  client: Client,
  server: Pick<
    OpenServer,
    "id" | "vaultId" | "kind" | "slug" | "name" | "description"
  >,
  id: string = newId(),
): Promise<string> {
  await client.serverDefinition.create({
    data: {
      id,
      vaultId: server.vaultId,
      kind: server.kind,
      slug: await uniqueDefinitionSlug(client, server.vaultId, server.slug),
      ...(ctx
        ? sealedDefinitionMeta(ctx, id, {
            name: server.name,
            description: server.description,
          })
        : { plainName: server.name, plainDescription: server.description }),
    },
  })
  await client.mcpServer.update({
    where: { id: server.id },
    data: { definitionId: id },
  })

  return id
}

/**
 * The server's definition's id, made now when a server of a kind that has
 * one has none yet (one restored from an older export, or made by code that
 * does not know about definitions). Null for the other kinds.
 */
export async function ensureDefinition(
  ctx: VaultContext,
  serverId: string,
): Promise<string | null> {
  const row = await db().mcpServer.findUnique({ where: { id: serverId } })

  if (!row || !hasDefinition(row.kind)) {
    return null
  }

  if (row.definitionId) {
    return row.definitionId
  }

  const server = openServer(ctx, row)
  return db().$transaction((tx) => newDefinitionFor(ctx, tx, server))
}

/**
 * Gives every server of a kind that has a definition and has none a
 * definition of its own, with the server's id when no definition has it.
 * For a restore of an export written before definitions, inside its
 * transaction.
 */
export async function backfillDefinitions(
  tx: Prisma.TransactionClient,
  vaultId: string,
  /** The vault's key, when the restore holds it. */
  ctx: VaultContext | null,
): Promise<number> {
  const rows = await tx.mcpServer.findMany({
    where: {
      vaultId,
      definitionId: null,
      kind: { in: [...DEFINITION_KINDS] },
    },
    orderBy: { createdAt: "asc" },
  })
  // A sealed row is given one by its first use with the key
  // (ensureDefinition) when the restore holds none; a row from before
  // names itself in plain text.
  const servers: Array<
    Pick<
      OpenServer,
      "id" | "vaultId" | "kind" | "slug" | "name" | "description"
    >
  > = []

  for (const row of rows) {
    if (row.meta !== null) {
      try {
        if (ctx) servers.push(openServer(ctx, row))
      } catch {
        // Not under this key: given one by its first use.
      }
    } else {
      servers.push({
        ...row,
        name: row.plainName,
        description: row.plainDescription,
      })
    }
  }

  for (const server of servers) {
    const taken = await tx.serverDefinition.findUnique({
      where: { id: server.id },
      select: { id: true },
    })
    await newDefinitionFor(ctx, tx, server, taken ? newId() : server.id)
  }

  return servers.length
}

/**
 * The definition an instance about to be made in this vault takes, checked:
 * it exists here and is of the same kind.
 */
export async function definitionForNew(
  ctx: VaultContext,
  definitionId: string,
  kind: DefinitionKind,
) {
  const row = await db().serverDefinition.findFirst({
    where: { id: definitionId, vaultId: ctx.vaultId },
  })

  if (!row) {
    throw notFound("That definition")
  }

  const definition = openDefinition(ctx, row)

  if (definition.kind !== kind) {
    throw invalid(
      `That definition is for ${definition.kind === "openapi" ? "an API endpoint" : definition.kind === "wrapper" ? "a wrapper" : definition.kind === "service" ? "a service" : "an MCP server"}.`,
    )
  }

  return definition
}

/**
 * An instance of the definition to copy shared content from: the oldest
 * that is not `exceptId`. Null when it has no other.
 */
export async function contentInstance(
  ctx: VaultContext,
  definitionId: string,
  exceptId?: string,
): Promise<OpenServer | null> {
  const row = await db().mcpServer.findFirst({
    where: {
      definitionId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    orderBy: { createdAt: "asc" },
  })

  return row ? openServer(ctx, row) : null
}

/** The other instances of a server's definition, oldest first. */
export async function siblingInstances(
  ctx: VaultContext,
  serverId: string,
): Promise<OpenServer[]> {
  const server = await db().mcpServer.findUnique({
    where: { id: serverId },
    select: { definitionId: true },
  })

  if (!server?.definitionId) {
    return []
  }

  return openServers(
    ctx,
    await db().mcpServer.findMany({
      where: { definitionId: server.definitionId, id: { not: serverId } },
      orderBy: { createdAt: "asc" },
    }),
  )
}

/**
 * Copies a server's description to its definition and every other instance
 * of it: called after anything writes one. Nothing for a server without a
 * definition. The descriptions are sealed, so each is opened and compared
 * here, and only one that differs is written.
 */
export async function shareDescription(
  ctx: VaultContext,
  serverId: string,
): Promise<void> {
  const row = await db().mcpServer.findUnique({
    where: { id: serverId },
    select: { ...SERVER_META_SELECT, definitionId: true },
  })

  if (!row?.definitionId) {
    return
  }

  const { description } = openServer(ctx, row)
  const definition = await db().serverDefinition.findUnique({
    where: { id: row.definitionId },
    select: DEFINITION_META_SELECT,
  })

  if (definition) {
    const meta = definitionMeta(ctx, definition)

    if (meta.description !== description) {
      await writeDefinition(ctx, definition.id, { description })
    }
  }

  for (const sibling of await siblingInstances(ctx, serverId)) {
    if (sibling.description !== description) {
      await writeServer(ctx, sibling.id, { description })
    }
  }
}

/**
 * A tool's description in the owner's words, on every other instance that
 * has the tool. The instance's own row is the caller's to write.
 */
export async function shareToolDescription(
  ctx: VaultContext,
  serverId: string,
  toolName: string,
  override: string | null,
): Promise<void> {
  const siblings = await siblingInstances(ctx, serverId)

  if (siblings.length === 0) {
    return
  }

  await writeToolOverride(
    ctx,
    { serverId: { in: siblings.map((sibling) => sibling.id) }, name: toolName },
    override,
  )
}

/**
 * The tool descriptions in the owner's words that the other instances of a
 * server's definition carry, by tool: what a tool new to this instance
 * starts with (catalogue.ts storeTools).
 */
export async function inheritedToolDescriptions(
  ctx: VaultContext,
  serverId: string,
): Promise<Map<string, string>> {
  const siblings = await siblingInstances(ctx, serverId)
  const found = new Map<string, string>()

  if (siblings.length === 0) {
    return found
  }

  const tools = await toolOverrides(ctx, {
    serverId: { in: siblings.map((sibling) => sibling.id) },
  })

  for (const tool of tools) {
    if (!found.has(tool.name)) {
      found.set(tool.name, tool.descriptionOverride)
    }
  }

  return found
}

/**
 * Switches off every other instance of a server's definition: for a change
 * to what they share that waits for the owner to enable it again.
 */
export async function disableOtherInstances(
  ctx: VaultContext,
  serverId: string,
): Promise<void> {
  const siblings = await siblingInstances(ctx, serverId)

  if (siblings.length > 0) {
    await db().mcpServer.updateMany({
      where: { id: { in: siblings.map((sibling) => sibling.id) } },
      data: { enabled: false },
    })
  }
}

/** Deletes a definition that no server is an instance of any more. */
export async function forgetUnusedDefinition(
  definitionId: string | null,
): Promise<void> {
  if (!definitionId) {
    return
  }

  const left = await db().mcpServer.count({ where: { definitionId } })

  if (left === 0) {
    await db().serverDefinition.deleteMany({ where: { id: definitionId } })
  }
}

/**
 * Changes a definition's name or description (and any other column given),
 * keeping the other sealed value as it is.
 */
export async function writeDefinition(
  ctx: VaultContext,
  id: string,
  patch: Partial<DefinitionMeta>,
  data: Omit<
    Prisma.ServerDefinitionUncheckedUpdateInput,
    "id" | "meta" | "plainName" | "plainDescription"
  > = {},
  client?: Client,
): Promise<void> {
  // The read and the write in one transaction: a change made at the same
  // time is read, never written over.
  if (!client) {
    await db().$transaction((tx) => writeDefinition(ctx, id, patch, data, tx))
    return
  }

  const row = await client.serverDefinition.findUnique({
    where: { id },
    select: DEFINITION_META_SELECT,
  })

  if (!row) {
    throw notFound("That definition")
  }

  await client.serverDefinition.update({
    where: { id },
    data: {
      ...data,
      ...sealedDefinitionMeta(ctx, id, {
        ...definitionMeta(ctx, row),
        ...patch,
      }),
    },
  })
}
