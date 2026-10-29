import type { McpServer } from "@/lib/generated/prisma/client"

import { SECRET_PLACEHOLDER } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { ensureDefinition } from "../definition-rows"
import { invalid, notFound } from "../errors"
import { storedSpec } from "../endpoints"
import { extraAuthHeaders } from "../servers"
import {
  readEnvBindings,
  readPublish,
  readServiceDefinition,
} from "../services/definition"
import { listSkills, type SkillEntry } from "../skills"
import { getWrapper } from "../wrappers/admin"
import type { WrapperAnnotations } from "../wrappers/definition"

import {
  specFormat,
  type EndpointAuthDocument,
  type EndpointDocument,
  type HeaderDocument,
  type ItemDocument,
  type ServerAuthDocument,
  type ServerDocument,
  type ServiceDocument,
  type SkillDocument,
  type WrapperDocument,
} from "./documents"
import { checkDistinct, itemSlug, type ItemKind } from "./layout"

/**
 * The vault's shareable items as documents (documents.ts): its skills, its
 * wrappers and browser flows, its API endpoints, its MCP servers and its
 * services. Other kinds (mail and calendar accounts, SSH servers, the
 * browser) hold what is the owner's alone and are never shared. The API
 * endpoint or MCP server a service registered is the service's: it is
 * shared as the service, never on its own (its address is the owner's
 * machine).
 *
 * A server's document is its definition (definitions.ts), the same from
 * every instance: the definition's short name and name, the description,
 * the schema, edits and tool descriptions, a wrapper's programs, and how it
 * signs in, by kind and header only. Nothing of one instance is read for it:
 * not its name, address, switches, note or levels, not which secret it
 * signs in with (only a wrapper's secret places name secrets, as its
 * programs need them), never a value and never an OAuth token. The vault
 * has one item per definition; the instance linked to a repository, or the
 * oldest, stands for it.
 */

/** An item of the vault: what it is in PCP, and as a document. */
export type LocalItem = {
  /** The skill's id, or the server row's (the instance standing for it). */
  id: string
  document: ItemDocument
}

/** The server kinds an item can be, by what they are in a repository. */
const SERVER_KINDS = ["mcp", "openapi", "wrapper", "service"] as const

async function secretNames(
  ctx: VaultContext,
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))]

  if (wanted.length === 0) {
    return new Map()
  }

  const rows = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, id: { in: wanted } },
    select: { id: true, name: true },
  })

  return new Map(rows.map((row) => [row.id, row.name]))
}

function skillDocument(entry: SkillEntry): SkillDocument {
  return {
    kind: "skill",
    name: entry.name,
    version: entry.version,
    description: entry.description,
    body: entry.body,
    tools: entry.tools,
    extra: entry.extra ?? {},
    files: [...entry.files].sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/** What a server's definition is called: its short name and its name. */
type Named = { slug: string; name: string }

/** The definition a row is an instance of, by its short name and name. */
async function definitionName(row: McpServer): Promise<Named> {
  const definitionId = row.definitionId ?? (await ensureDefinition(row.id))
  const definition = definitionId
    ? await db().serverDefinition.findUnique({
        where: { id: definitionId },
        select: { slug: true, name: true },
      })
    : null

  return definition
    ? { slug: itemSlug(definition.slug), name: definition.name }
    : { slug: itemSlug(row.slug), name: row.name }
}

async function wrapperDocument(
  ctx: VaultContext,
  row: McpServer,
  named: Named,
): Promise<WrapperDocument> {
  const view = await getWrapper(ctx, { id: row.id })

  return {
    kind: view.flow ? "flow" : "wrapper",
    name: named.slug,
    version: row.syncVersion ?? 1,
    displayName: named.name,
    description: view.description,
    callLevels: view.callLevels,
    tools: view.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.outputSchema
        ? { outputSchema: tool.outputSchema as Record<string, unknown> }
        : {}),
      annotations: (tool.annotations as WrapperAnnotations | null) ?? null,
      calls: tool.calls,
      replaces: tool.replaces,
      program: tool.program,
    })),
    secrets: view.secrets.map((binding) => ({
      secret: binding.secret,
      tool: binding.tool,
      argument: binding.argument,
      template: binding.template,
    })),
  }
}

/** A header-authenticated row's headers and their formats, no secret. */
async function headerAuth(
  row: McpServer,
): Promise<EndpointAuthDocument & { kind: "header" }> {
  const extras = await extraAuthHeaders(row.id)
  const headers: HeaderDocument[] = extras.map((extra) => ({
    header: extra.headerName,
    template: extra.valueTemplate,
    secret: null,
  }))

  return {
    kind: "header",
    header: row.authHeaderName ?? "Authorization",
    template: row.authValueTemplate ?? SECRET_PLACEHOLDER,
    secret: null,
    headers,
  }
}

function oauthAuth(row: McpServer): EndpointAuthDocument & { kind: "oauth" } {
  return {
    kind: "oauth",
    clientId: null,
    clientSecret: null,
    scope: row.oauthScope,
    authorizeParams: row.oauthAuthorizeParams,
  }
}

/**
 * How an instance signs in, in words, with its secrets by name, its login
 * and its OAuth client: what stays in the vault when its definition is
 * shared (share-review.ts's "Stays private").
 */
export async function instanceSignIn(
  ctx: VaultContext,
  row: McpServer,
): Promise<string[]> {
  const extras = row.authType === "header" ? await extraAuthHeaders(row.id) : []
  const names = await secretNames(ctx, [
    row.authSecretId,
    row.oauthClientSecretId,
    ...extras.map((extra) => extra.secretId),
  ])
  const name = (id: string | null) =>
    `"${(id ? names.get(id) : null) ?? "(none)"}"`

  switch (row.authType) {
    case "header":
      return [
        `the secret ${name(row.authSecretId)} in ${row.authHeaderName ?? "Authorization"}`,
        ...extras.map(
          (extra) =>
            `the secret ${name(extra.secretId)} in ${extra.headerName}`,
        ),
      ]
    case "basic":
      return [
        `the user name ${row.authUsername ?? "(none)"} with the secret ${name(row.authSecretId)}`,
      ]
    case "oauth":
      return [
        row.oauthClientId
          ? `the OAuth client ${row.oauthClientId}${row.oauthClientSecretId ? ` with the secret ${name(row.oauthClientSecretId)}` : ""}, and PCP's sign-in there`
          : "PCP's OAuth sign-in there",
      ]
    default:
      return []
  }
}

/**
 * What a service instance has of its own, in words: the SSH server it runs
 * on, where it is published, its container, which secret (by name) each
 * variable takes and what it registered. What stays in the vault when its
 * definition is shared (share-review.ts's "Stays private").
 */
export async function serviceOwnLines(
  ctx: VaultContext,
  row: McpServer,
): Promise<{
  runsOn: string
  published: string
  container: string
  secrets: string[]
  registered: string | null
}> {
  const spec = await db().serviceSpec.findUnique({
    where: { serverId: row.id },
    include: {
      host: { select: { name: true, vaultId: true } },
      registered: { select: { name: true, slug: true } },
    },
  })

  if (!spec) {
    return {
      runsOn: "(none)",
      published: "(none)",
      container: "(none)",
      secrets: [],
      registered: null,
    }
  }

  const bindings = readEnvBindings(spec.env)
  const names = await secretNames(ctx, Object.values(bindings))
  const publish = readPublish(spec.publish)

  return {
    runsOn:
      spec.host && spec.host.vaultId === ctx.vaultId
        ? spec.host.name
        : "(an SSH server since deleted)",
    published:
      publish.ports.length > 0
        ? publish.ports
            .map(
              (port) => `${publish.address}:${port.host} (${port.container})`,
            )
            .join(", ")
        : "No ports",
    container: spec.containerName,
    secrets: Object.entries(bindings).map(
      ([name, id]) => `${name} takes "${names.get(id) ?? "(none)"}"`,
    ),
    registered: spec.registered
      ? `${spec.registered.name} (${spec.registered.slug})`
      : null,
  }
}

async function endpointDocument(
  row: McpServer,
  named: Named,
): Promise<EndpointDocument> {
  const spec = await storedSpec(row.id)

  if (!spec) {
    throw invalid(`${row.name} has no stored schema to share.`)
  }

  const tools = await db().mcpTool.findMany({
    where: { serverId: row.id, descriptionOverride: { not: null } },
    select: { name: true, descriptionOverride: true },
    orderBy: { name: "asc" },
  })
  let auth: EndpointAuthDocument

  switch (row.authType) {
    case "header":
      auth = await headerAuth(row)
      break
    case "basic":
      auth = { kind: "basic", username: null, secret: null }
      break
    case "oauth":
      auth = oauthAuth(row)
      break
    default:
      auth = { kind: "none" }
  }

  return {
    kind: "endpoint",
    name: named.slug,
    version: row.syncVersion ?? 1,
    displayName: named.name,
    description: row.description,
    instance: null,
    spec: { format: specFormat(spec.text), text: spec.text },
    patches: spec.patches,
    toolDescriptions: Object.fromEntries(
      tools.map((tool) => [tool.name, tool.descriptionOverride!]),
    ),
    auth,
  }
}

async function serverDocument(
  row: McpServer,
  named: Named,
): Promise<ServerDocument> {
  let auth: ServerAuthDocument

  switch (row.authType) {
    case "header":
      auth = await headerAuth(row)
      break
    case "oauth":
      auth = oauthAuth(row)
      break
    default:
      auth = { kind: "none" }
  }

  return {
    kind: "server",
    name: named.slug,
    version: row.syncVersion ?? 1,
    displayName: named.name,
    description: row.description,
    instance: null,
    auth,
  }
}

/**
 * A service's definition, as every instance of it shares it: never the SSH
 * server, the published address, the secrets its variables take, its
 * container or what it registered.
 */
async function serviceDocument(
  row: McpServer,
  named: Named,
): Promise<ServiceDocument> {
  const spec = await db().serviceSpec.findUnique({
    where: { serverId: row.id },
    select: { definition: true },
  })

  if (!spec) {
    throw invalid(`${row.name} has no service definition to share.`)
  }

  return {
    kind: "service",
    name: named.slug,
    version: row.syncVersion ?? 1,
    displayName: named.name,
    description: row.description,
    definition: readServiceDefinition(spec.definition),
  }
}

async function documentOfRow(
  ctx: VaultContext,
  row: McpServer,
): Promise<ItemDocument> {
  if (
    row.kind !== "wrapper" &&
    row.kind !== "openapi" &&
    row.kind !== "mcp" &&
    row.kind !== "service"
  ) {
    throw invalid(`${row.name} is not something PCP shares in a repository.`)
  }

  const named = await definitionName(row)

  switch (row.kind) {
    case "wrapper":
      return wrapperDocument(ctx, row, named)
    case "openapi":
      return endpointDocument(row, named)
    case "mcp":
      return serverDocument(row, named)
    case "service":
      return serviceDocument(row, named)
  }
}

/** One item of the vault, by its kind and id, as a document. */
export async function localItem(
  ctx: VaultContext,
  kind: ItemKind,
  id: string,
): Promise<LocalItem> {
  if (kind === "skill") {
    const entry = (await listSkills(ctx)).find((skill) => skill.id === id)

    if (!entry) {
      throw notFound("That skill")
    }

    return { id, document: skillDocument(entry) }
  }

  const row = await db().mcpServer.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!row) {
    throw notFound("That server")
  }

  const document = await documentOfRow(ctx, row)

  if (
    document.kind !== kind &&
    !(
      (kind === "wrapper" || kind === "flow") &&
      (document.kind === "wrapper" || document.kind === "flow")
    )
  ) {
    throw invalid(`${row.name} is not a ${kind}.`)
  }

  return { id, document }
}

/** A server row as an item: its kind, or null for one PCP never shares. */
export function itemKindOfServer(serverKind: string): ItemKind | null {
  return serverKind === "mcp"
    ? "server"
    : serverKind === "openapi"
      ? "endpoint"
      : serverKind === "wrapper"
        ? "wrapper"
        : serverKind === "service"
          ? "service"
          : null
}

/**
 * The instance that stands for each definition: the one linked to a
 * repository, else the oldest. Rows of kinds that are never shared,
 * instances that do not stand for theirs, and what a service registered
 * (shared as the service) are left out.
 */
async function standingRows(ctx: VaultContext): Promise<McpServer[]> {
  const registered = (
    await db().serviceSpec.findMany({
      where: { server: { vaultId: ctx.vaultId }, registeredId: { not: null } },
      select: { registeredId: true },
    })
  ).map((spec) => spec.registeredId!)
  const rows = await db().mcpServer.findMany({
    where: {
      vaultId: ctx.vaultId,
      kind: { in: [...SERVER_KINDS] },
      id: { notIn: registered },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  const linked = new Set(
    (
      await db().repoItem.findMany({
        where: { serverId: { in: rows.map((row) => row.id) } },
        select: { serverId: true },
      })
    ).map((item) => item.serverId),
  )
  const chosen = new Map<string, McpServer>()

  for (const row of rows) {
    const key = row.definitionId ?? row.id
    const held = chosen.get(key)

    if (!held || (linked.has(row.id) && !linked.has(held.id))) {
      chosen.set(key, row)
    }
  }

  return [...chosen.values()]
}

/**
 * Every shareable item of the vault, as documents: skills first, then
 * servers by short name, one per definition. A row that cannot be one (an
 * endpoint with no stored schema) is left out, and listed in `skipped`
 * with why. Two that would be at one path are refused (layout.ts).
 */
export async function localItems(
  ctx: VaultContext,
  skipped: Array<{ id: string; name: string; message: string }> = [],
): Promise<LocalItem[]> {
  const skills = (await listSkills(ctx)).map((entry) => ({
    id: entry.id,
    document: skillDocument(entry) as ItemDocument,
  }))
  const servers: LocalItem[] = []

  for (const row of await standingRows(ctx)) {
    try {
      servers.push({ id: row.id, document: await documentOfRow(ctx, row) })
    } catch (error) {
      skipped.push({
        id: row.id,
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  servers.sort((a, b) => a.document.name.localeCompare(b.document.name))
  const items = [...skills, ...servers]
  checkDistinct(
    items.map((item) => ({
      kind: item.document.kind,
      name: item.document.name,
    })),
  )

  return items
}

/**
 * What in the vault has a repository item's name: a skill by its name; a
 * server, endpoint or wrapper by its definition's short name (the instance
 * linked to a repository, or the oldest, standing for it); null when
 * nothing does. `kind` is what the row is as an item (a wrapper's kind is
 * the one asked about, flow or not), or null when the name is a server PCP
 * never shares (a mail account, say): applying the item then is refused for
 * its name.
 */
export async function findLocalItem(
  ctx: VaultContext,
  ref: { kind: ItemKind; name: string },
): Promise<{ id: string; kind: ItemKind | null } | null> {
  if (ref.kind === "skill") {
    const entry = (await listSkills(ctx)).find(
      (skill) => skill.name === ref.name,
    )
    return entry ? { id: entry.id, kind: "skill" } : null
  }

  const asItem = (serverKind: string): ItemKind | null => {
    const kind = itemKindOfServer(serverKind)
    return kind === "wrapper" && ref.kind === "flow" ? "flow" : kind
  }
  const definition = await db().serverDefinition.findUnique({
    where: { vaultId_slug: { vaultId: ctx.vaultId, slug: ref.name } },
    select: { id: true, kind: true },
  })

  if (definition) {
    const instances = await db().mcpServer.findMany({
      where: { definitionId: definition.id, vaultId: ctx.vaultId },
      select: { id: true, repoItems: { select: { id: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    const standing =
      instances.find((instance) => instance.repoItems.length > 0) ??
      instances[0]

    if (standing) {
      return { id: standing.id, kind: asItem(definition.kind) }
    }
  }

  // A server of a kind without definitions goes by its own short name.
  const row = await db().mcpServer.findUnique({
    where: { vaultId_slug: { vaultId: ctx.vaultId, slug: ref.name } },
    select: { id: true, kind: true },
  })

  return row && itemKindOfServer(row.kind) === null
    ? { id: row.id, kind: null }
    : null
}
