import type { McpServer } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { sha256Hex } from "./crypto"
import { db } from "./db"
import {
  contentInstance,
  ensureDefinition,
  hasDefinition,
  newDefinitionFor,
  type DefinitionKind,
} from "./definition-rows"
import { createEndpoint } from "./endpoints"
import { invalid, notFound, PcpError } from "./errors"
import { checkPersonalNote, setPersonalNote } from "./personal-notes"
import { canonicalJson } from "./permission-rules"
import { createServer, getServer, type ExtraAuthHeaderInput } from "./servers"
import { getSetting, setSetting } from "./settings"

/**
 * Definitions and instances, as the owner works with them.
 *
 * A definition is what a server is, as it could be shared: its description,
 * an endpoint's schema and edits, a wrapper's program, the tools'
 * descriptions in the owner's words. An instance is one server of it in this
 * vault: its name and short name, its address, its credential, its levels,
 * whether it is on, its pace, and the owner's note. Every MCP server, API
 * endpoint and wrapper is an instance of one definition, alone at first.
 *
 * Cloning makes another instance of the same definition, with its own
 * address, secret and note, and the source's levels. Detaching gives an
 * instance a definition of its own again. Endpoints whose schemas, edits and
 * tool descriptions are the same can be merged into one definition, on the
 * owner's word. How shared content is kept the same on every instance is
 * definition-rows.ts.
 *
 * The note is the owner's alone: encrypted, never in a repository document
 * or anything shared, and shown to assistants as the owner's note beside the
 * description.
 */

export { DEFINITION_KINDS, hasDefinition } from "./definition-rows"
export type { DefinitionKind } from "./definition-rows"
export {
  checkPersonalNote,
  ownerNoteLine,
  readServerNote,
  readSkillNote,
  setPersonalNote,
  type NoteKind,
} from "./personal-notes"

// ---- Definitions and their instances -------------------------------------

export type DefinitionInstance = {
  id: string
  name: string
  slug: string
  url: string
  enabled: boolean
}

export type DefinitionView = {
  id: string
  kind: DefinitionKind
  slug: string
  name: string
  description: string
  formatVersion: number
  /** Every server of it, oldest first. */
  instances: DefinitionInstance[]
}

function instanceOf(row: McpServer): DefinitionInstance {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: row.url,
    enabled: row.enabled,
  }
}

/** Every server of a definition in this vault, oldest first. */
export async function instancesOf(
  ctx: VaultContext,
  definitionId: string,
): Promise<DefinitionInstance[]> {
  const rows = await db().mcpServer.findMany({
    where: { definitionId, vaultId: ctx.vaultId },
    orderBy: { createdAt: "asc" },
  })

  return rows.map(instanceOf)
}

async function viewOf(
  ctx: VaultContext,
  definitionId: string,
): Promise<DefinitionView | null> {
  const row = await db().serverDefinition.findFirst({
    where: { id: definitionId, vaultId: ctx.vaultId },
  })

  if (!row || !hasDefinition(row.kind)) {
    return null
  }

  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    description: row.description,
    formatVersion: row.formatVersion,
    instances: await instancesOf(ctx, row.id),
  }
}

/** A definition of this vault by its id, or null. */
export async function getDefinition(
  ctx: VaultContext,
  definitionId: string,
): Promise<DefinitionView | null> {
  return viewOf(ctx, definitionId)
}

/**
 * The definition a server is an instance of, with all its instances; made
 * now for one that has none yet. Null for a kind without definitions (mail,
 * calendar, SSH, the browser).
 */
export async function definitionOf(
  ctx: VaultContext,
  serverId: string,
): Promise<DefinitionView | null> {
  const server = await getServer(ctx, serverId)
  const definitionId = await ensureDefinition(server.id)

  return definitionId ? viewOf(ctx, definitionId) : null
}

// ---- Clone -----------------------------------------------------------------

/** What a clone asks for: what is the instance's own. */
export type CloneInput = {
  name: string
  /** An endpoint's base URL; an MCP server's address. */
  url: string
  note?: string | null
  authType: "none" | "header" | "basic" | "oauth"
  authHeaderName?: string | null
  authValueTemplate?: string | null
  /** A secret's id, or NEW_SECRET for one typed in. */
  authSecretId?: string | null
  authSecretName?: string | null
  authSecretValue?: string | null
  authUsername?: string | null
  oauthClientId?: string | null
  oauthClientSecretId?: string | null
  oauthClientSecretValue?: string | null
  oauthScope?: string | null
  oauthAuthorizeParams?: string | null
  /** Further secret headers, each with a stored secret of the clone's own. */
  authExtraHeaders?: ExtraAuthHeaderInput[] | null
}

/** The kinds a clone can be made of: each takes an address of its own. */
export function canClone(kind: string): boolean {
  return kind === "openapi" || kind === "mcp"
}

/**
 * Another server of the same definition as `serverId`: the definition's
 * description, schema, edits and tool descriptions, with its own name,
 * address, credential and note, and the levels the source has, for each
 * token and for all tokens. Tokens limited to some servers do not reach it
 * until the owner adds it to them, as with any new server.
 */
export async function cloneServer(
  ctx: VaultContext,
  serverId: string,
  input: CloneInput,
): Promise<{ id: string }> {
  const source = await getServer(ctx, serverId)

  if (!canClone(source.kind)) {
    throw new PcpError(
      "state",
      "Only MCP servers and API endpoints can be cloned: each clone has an address of its own.",
    )
  }

  // Checked before anything is made.
  const note = checkPersonalNote(input.note)
  const url = input.url.trim()

  if (!url) {
    throw invalid(
      source.kind === "openapi"
        ? "Enter the base URL the clone sends its requests to."
        : "Enter the clone's address.",
    )
  }

  const definitionId = (await ensureDefinition(source.id))!
  const auth = {
    authHeaderName: input.authHeaderName,
    authValueTemplate: input.authValueTemplate,
    authSecretId: input.authSecretId,
    authSecretName: input.authSecretName,
    authSecretValue: input.authSecretValue,
    oauthClientId: input.oauthClientId,
    oauthClientSecretId: input.oauthClientSecretId,
    oauthClientSecretValue: input.oauthClientSecretValue,
    oauthScope: input.oauthScope,
    oauthAuthorizeParams: input.oauthAuthorizeParams,
    authExtraHeaders: input.authExtraHeaders,
  }
  let id: string

  if (source.kind === "openapi") {
    ;({ id } = await createEndpoint(ctx, {
      name: input.name,
      baseUrl: url,
      // The definition's schema and description replace these.
      specSource: "url",
      readOnly: source.readOnly,
      publicOnly: source.publicOnly,
      authType: input.authType,
      authUsername: input.authUsername,
      ...auth,
      definitionId,
    }))
  } else {
    if (input.authType === "basic") {
      throw invalid(
        "An MCP server signs in with a secret in a header or with OAuth.",
      )
    }

    ;({ id } = await createServer(ctx, {
      name: input.name,
      url,
      authType: input.authType,
      publicOnly: source.publicOnly,
      ...auth,
      definitionId,
    }))
  }

  await copyLevels(source.id, id)

  if (note) {
    await setPersonalNote(ctx, "server", id, note)
  }

  return { id }
}

/** The levels of one server's tools, for each token and for all, onto another. */
async function copyLevels(fromId: string, toId: string): Promise<void> {
  const [own, shared] = await Promise.all([
    db().apiTokenToolAccess.findMany({ where: { serverId: fromId } }),
    db().vaultToolAccess.findMany({ where: { serverId: fromId } }),
  ])

  await db().$transaction([
    ...own.map((row) =>
      db().apiTokenToolAccess.create({
        data: {
          tokenId: row.tokenId,
          serverId: toId,
          toolName: row.toolName,
          access: row.access,
        },
      }),
    ),
    ...shared.map((row) =>
      db().vaultToolAccess.create({
        data: {
          vaultId: row.vaultId,
          serverId: toId,
          toolName: row.toolName,
          access: row.access,
        },
      }),
    ),
  ])
}

// ---- Detach ----------------------------------------------------------------

/**
 * Gives a server a definition of its own, named after it, with what it
 * shared until now: from here a change to it changes it alone, and a change
 * to the others does not reach it.
 */
export async function detachServer(
  ctx: VaultContext,
  serverId: string,
): Promise<{ definitionId: string }> {
  const server = await getServer(ctx, serverId)
  const definitionId = await ensureDefinition(server.id)

  if (!definitionId) {
    throw new PcpError("state", `${server.name} has no definition to detach.`)
  }

  const others = await db().mcpServer.count({
    where: { definitionId, id: { not: server.id } },
  })

  if (others === 0) {
    throw new PcpError(
      "state",
      `${server.name} is the only server of its definition already.`,
    )
  }

  return {
    definitionId: await db().$transaction((tx) => newDefinitionFor(tx, server)),
  }
}

// ---- The same schema twice -------------------------------------------------

export type IdenticalDefinitions = {
  /** What the definitions share, as a fingerprint: what a merge is checked against. */
  key: string
  kind: "openapi"
  definitions: DefinitionView[]
}

const DISMISSED_MERGES = "definitions.dismissedMerges"
const MAX_DISMISSED = 100

async function dismissedMerges(ctx: VaultContext): Promise<string[]> {
  try {
    const value = JSON.parse((await getSetting(ctx, DISMISSED_MERGES)) ?? "[]")
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : []
  } catch {
    return []
  }
}

/**
 * What an endpoint's definition holds, as one fingerprint: the schema's,
 * its edits and the tool descriptions in the owner's words. Two definitions
 * with the same one build the same tools.
 */
async function contentKey(serverId: string): Promise<string | null> {
  const [spec, tools] = await Promise.all([
    db().openApiSpec.findUnique({
      where: { serverId },
      select: { hash: true, patches: true },
    }),
    db().mcpTool.findMany({
      where: { serverId, descriptionOverride: { not: null } },
      select: { name: true, descriptionOverride: true },
      orderBy: { name: "asc" },
    }),
  ])

  if (!spec) {
    return null
  }

  let patches: unknown

  try {
    patches = JSON.parse(spec.patches)
  } catch {
    patches = spec.patches
  }

  return sha256Hex(
    canonicalJson({
      spec: spec.hash,
      patches,
      tools: tools.map((tool) => [tool.name, tool.descriptionOverride]),
    }),
  )
}

/** The fingerprint of each endpoint definition in the vault, by definition. */
async function endpointKeys(
  ctx: VaultContext,
  only?: string[],
): Promise<Map<string, string>> {
  const servers = await db().mcpServer.findMany({
    where: {
      vaultId: ctx.vaultId,
      kind: "openapi",
      definitionId: only ? { in: only } : { not: null },
    },
    select: { id: true, definitionId: true, spec: { select: { hash: true } } },
    orderBy: { createdAt: "asc" },
  })
  // One instance stands for each definition: they all hold the same.
  const byDefinition = new Map<string, { id: string; hash: string }>()

  for (const server of servers) {
    if (server.spec && !byDefinition.has(server.definitionId!)) {
      byDefinition.set(server.definitionId!, {
        id: server.id,
        hash: server.spec.hash,
      })
    }
  }

  // Only a schema seen twice is worth a closer look.
  const hashes = new Map<string, number>()

  for (const { hash } of byDefinition.values()) {
    hashes.set(hash, (hashes.get(hash) ?? 0) + 1)
  }

  const keys = new Map<string, string>()

  for (const [definitionId, { id, hash }] of byDefinition) {
    if (only || (hashes.get(hash) ?? 0) > 1) {
      const key = await contentKey(id)

      if (key) {
        keys.set(definitionId, key)
      }
    }
  }

  return keys
}

/**
 * Endpoint definitions that hold the same schema, edits and tool
 * descriptions, in groups: what the owner is offered to merge. Groups they
 * said no to are left out.
 */
export async function findIdenticalDefinitions(
  ctx: VaultContext,
): Promise<IdenticalDefinitions[]> {
  const keys = await endpointKeys(ctx)
  const dismissed = new Set(await dismissedMerges(ctx))
  const groups = new Map<string, string[]>()

  for (const [definitionId, key] of keys) {
    if (!dismissed.has(key)) {
      groups.set(key, [...(groups.get(key) ?? []), definitionId])
    }
  }

  const found: IdenticalDefinitions[] = []

  for (const [key, ids] of groups) {
    if (ids.length < 2) {
      continue
    }

    const definitions = (
      await Promise.all(ids.map((id) => viewOf(ctx, id)))
    ).filter((view): view is DefinitionView => view !== null)

    if (definitions.length > 1) {
      found.push({ key, kind: "openapi", definitions })
    }
  }

  return found
}

/** One group of the same schema, by its key, or null when it is no more. */
export async function identicalDefinitions(
  ctx: VaultContext,
  key: string,
): Promise<IdenticalDefinitions | null> {
  return (
    (await findIdenticalDefinitions(ctx)).find((group) => group.key === key) ??
    null
  )
}

/** The owner said these need not be merged: the offer goes away. */
export async function dismissMerge(
  ctx: VaultContext,
  key: string,
): Promise<void> {
  const keys = (await dismissedMerges(ctx)).filter((each) => each !== key)
  await setSetting(
    ctx,
    DISMISSED_MERGES,
    JSON.stringify([...keys, key].slice(-MAX_DISMISSED)),
  )
}

/**
 * Makes the servers of `mergeIds` instances of `keepId`, and deletes those
 * definitions: one definition, every server of them its instance. Only for
 * endpoint definitions that hold the same schema, edits and tool
 * descriptions, checked again now (and against `key`, the group the owner
 * was shown, when given). The instances take the kept definition's
 * description and where it reads its schema from; their own names,
 * addresses, credentials, levels and notes stay. `name`, when given,
 * renames the kept definition.
 */
export async function mergeDefinitions(
  ctx: VaultContext,
  keepId: string,
  mergeIds: string[],
  options: { key?: string; name?: string } = {},
): Promise<DefinitionView> {
  const others = [...new Set(mergeIds)].filter((id) => id !== keepId)

  if (others.length === 0) {
    throw invalid("Choose at least one other definition to merge.")
  }

  const rows = await db().serverDefinition.findMany({
    where: { id: { in: [keepId, ...others] }, vaultId: ctx.vaultId },
  })

  if (rows.length !== others.length + 1) {
    throw notFound("A definition to merge")
  }

  if (rows.some((row) => row.kind !== "openapi")) {
    throw invalid("Only API endpoints with the same schema are merged.")
  }

  const keys = await endpointKeys(ctx, [keepId, ...others])
  const keepKey = keys.get(keepId)

  if (
    !keepKey ||
    others.some((id) => keys.get(id) !== keepKey) ||
    (options.key !== undefined && options.key !== keepKey)
  ) {
    throw new PcpError(
      "state",
      "These endpoints no longer have the same schema, edits and tool descriptions, so nothing was merged. Look again.",
    )
  }

  const source = await contentInstance(keepId)
  const kept = rows.find((row) => row.id === keepId)!
  const name = options.name?.trim()

  if (!source) {
    throw notFound("The kept definition's endpoint")
  }

  await db().$transaction([
    db().mcpServer.updateMany({
      where: { definitionId: { in: others }, vaultId: ctx.vaultId },
      data: {
        definitionId: keepId,
        description: kept.description,
        specSource: source.specSource,
        specUrl: source.specUrl,
        specUrlFromAssistant: source.specUrlFromAssistant,
      },
    }),
    db().serverDefinition.deleteMany({ where: { id: { in: others } } }),
    ...(name && name !== kept.name
      ? [
          db().serverDefinition.update({
            where: { id: keepId },
            data: { name: name.slice(0, 200) },
          }),
        ]
      : []),
  ])

  return (await viewOf(ctx, keepId))!
}
