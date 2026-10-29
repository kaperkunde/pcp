import type { McpServer, Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"

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
  client: Client,
  server: Pick<
    McpServer,
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
      name: server.name,
      description: server.description,
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
  serverId: string,
): Promise<string | null> {
  const server = await db().mcpServer.findUnique({ where: { id: serverId } })

  if (!server || !hasDefinition(server.kind)) {
    return null
  }

  if (server.definitionId) {
    return server.definitionId
  }

  return db().$transaction((tx) => newDefinitionFor(tx, server))
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
): Promise<number> {
  const servers = await tx.mcpServer.findMany({
    where: {
      vaultId,
      definitionId: null,
      kind: { in: [...DEFINITION_KINDS] },
    },
    orderBy: { createdAt: "asc" },
  })

  for (const server of servers) {
    const taken = await tx.serverDefinition.findUnique({
      where: { id: server.id },
      select: { id: true },
    })
    await newDefinitionFor(tx, server, taken ? newId() : server.id)
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
  const definition = await db().serverDefinition.findFirst({
    where: { id: definitionId, vaultId: ctx.vaultId },
  })

  if (!definition) {
    throw notFound("That definition")
  }

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
  definitionId: string,
  exceptId?: string,
): Promise<McpServer | null> {
  return db().mcpServer.findFirst({
    where: {
      definitionId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    orderBy: { createdAt: "asc" },
  })
}

/** The other instances of a server's definition, oldest first. */
export async function siblingInstances(serverId: string): Promise<McpServer[]> {
  const server = await db().mcpServer.findUnique({
    where: { id: serverId },
    select: { definitionId: true },
  })

  if (!server?.definitionId) {
    return []
  }

  return db().mcpServer.findMany({
    where: { definitionId: server.definitionId, id: { not: serverId } },
    orderBy: { createdAt: "asc" },
  })
}

/**
 * Copies a server's description to its definition and every other instance
 * of it: called after anything writes one. Nothing for a server without a
 * definition.
 */
export async function shareDescription(serverId: string): Promise<void> {
  const server = await db().mcpServer.findUnique({
    where: { id: serverId },
    select: { definitionId: true, description: true },
  })

  if (!server?.definitionId) {
    return
  }

  await db().$transaction([
    db().serverDefinition.updateMany({
      where: {
        id: server.definitionId,
        description: { not: server.description },
      },
      data: { description: server.description },
    }),
    db().mcpServer.updateMany({
      where: {
        definitionId: server.definitionId,
        id: { not: serverId },
        description: { not: server.description },
      },
      data: { description: server.description },
    }),
  ])
}

/**
 * A tool's description in the owner's words, on every other instance that
 * has the tool. The instance's own row is the caller's to write.
 */
export async function shareToolDescription(
  serverId: string,
  toolName: string,
  override: string | null,
): Promise<void> {
  const siblings = await siblingInstances(serverId)

  if (siblings.length === 0) {
    return
  }

  await db().mcpTool.updateMany({
    where: {
      serverId: { in: siblings.map((sibling) => sibling.id) },
      name: toolName,
    },
    data: { descriptionOverride: override },
  })
}

/**
 * The tool descriptions in the owner's words that the other instances of a
 * server's definition carry, by tool: what a tool new to this instance
 * starts with (catalogue.ts storeTools).
 */
export async function inheritedToolDescriptions(
  serverId: string,
): Promise<Map<string, string>> {
  const siblings = await siblingInstances(serverId)
  const found = new Map<string, string>()

  if (siblings.length === 0) {
    return found
  }

  const tools = await db().mcpTool.findMany({
    where: {
      serverId: { in: siblings.map((sibling) => sibling.id) },
      descriptionOverride: { not: null },
    },
    select: { name: true, descriptionOverride: true },
  })

  for (const tool of tools) {
    if (!found.has(tool.name)) {
      found.set(tool.name, tool.descriptionOverride!)
    }
  }

  return found
}

/**
 * Switches off every other instance of a server's definition: for a change
 * to what they share that waits for the owner to enable it again.
 */
export async function disableOtherInstances(serverId: string): Promise<void> {
  const siblings = await siblingInstances(serverId)

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
