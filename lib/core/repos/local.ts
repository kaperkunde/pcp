import type { McpServer } from "@/lib/generated/prisma/client"

import { SECRET_PLACEHOLDER } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound } from "../errors"
import { storedSpec } from "../endpoints"
import { extraAuthHeaders } from "../servers"
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
  type SkillDocument,
  type WrapperDocument,
} from "./documents"
import { checkDistinct, itemSlug, type ItemKind } from "./layout"

/**
 * The vault's shareable items as documents (documents.ts): its skills, its
 * wrappers and browser flows, its API endpoints and its MCP servers. Other
 * kinds (mail and calendar accounts, SSH servers, the browser) hold what is
 * the owner's alone and are never shared. Only names of secrets are read,
 * never a value, and never an OAuth token.
 */

/** An item of the vault: what it is in PCP, and as a document. */
export type LocalItem = {
  /** The skill's id, or the server row's. */
  id: string
  document: ItemDocument
}

/** The server kinds an item can be, by what they are in a repository. */
const SERVER_KINDS = ["mcp", "openapi", "wrapper"] as const

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

/** The name an item of this row goes by in a repository. */
function serverName(row: Pick<McpServer, "slug">): string {
  return itemSlug(row.slug)
}

async function wrapperDocument(
  ctx: VaultContext,
  row: McpServer,
): Promise<WrapperDocument> {
  const view = await getWrapper(ctx, { id: row.id })

  return {
    kind: view.flow ? "flow" : "wrapper",
    name: serverName(row),
    version: row.syncVersion ?? 1,
    displayName: view.name,
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

/** A header-authenticated row's headers, secrets by name. */
async function headerAuth(
  ctx: VaultContext,
  row: McpServer,
): Promise<EndpointAuthDocument & { kind: "header" }> {
  const extras = await extraAuthHeaders(row.id)
  const names = await secretNames(ctx, [
    row.authSecretId,
    ...extras.map((extra) => extra.secretId),
  ])
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  const headers: HeaderDocument[] = extras.map((extra) => ({
    header: extra.headerName,
    template: extra.valueTemplate,
    secret: name(extra.secretId),
  }))

  return {
    kind: "header",
    header: row.authHeaderName ?? "Authorization",
    template: row.authValueTemplate ?? SECRET_PLACEHOLDER,
    secret: name(row.authSecretId),
    headers,
  }
}

async function oauthAuth(
  ctx: VaultContext,
  row: McpServer,
): Promise<EndpointAuthDocument & { kind: "oauth" }> {
  const names = await secretNames(ctx, [row.oauthClientSecretId])

  return {
    kind: "oauth",
    clientId: row.oauthClientId,
    clientSecret: row.oauthClientSecretId
      ? (names.get(row.oauthClientSecretId) ?? null)
      : null,
    scope: row.oauthScope,
    authorizeParams: row.oauthAuthorizeParams,
  }
}

async function endpointDocument(
  ctx: VaultContext,
  row: McpServer,
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
      auth = await headerAuth(ctx, row)
      break
    case "basic": {
      const names = await secretNames(ctx, [row.authSecretId])
      auth = {
        kind: "basic",
        username: row.authUsername ?? "",
        secret: row.authSecretId ? (names.get(row.authSecretId) ?? null) : null,
      }
      break
    }
    case "oauth":
      auth = await oauthAuth(ctx, row)
      break
    default:
      auth = { kind: "none" }
  }

  return {
    kind: "endpoint",
    name: serverName(row),
    version: row.syncVersion ?? 1,
    displayName: row.name,
    description: row.description,
    baseUrl: row.url,
    readOnly: row.readOnly,
    publicOnly: row.publicOnly,
    spec: { format: specFormat(spec.text), text: spec.text },
    patches: spec.patches,
    toolDescriptions: Object.fromEntries(
      tools.map((tool) => [tool.name, tool.descriptionOverride!]),
    ),
    auth,
  }
}

async function serverDocument(
  ctx: VaultContext,
  row: McpServer,
): Promise<ServerDocument> {
  let auth: ServerAuthDocument

  switch (row.authType) {
    case "header":
      auth = await headerAuth(ctx, row)
      break
    case "oauth":
      auth = await oauthAuth(ctx, row)
      break
    default:
      auth = { kind: "none" }
  }

  return {
    kind: "server",
    name: serverName(row),
    version: row.syncVersion ?? 1,
    displayName: row.name,
    description: row.description,
    url: row.url,
    publicOnly: row.publicOnly,
    auth,
  }
}

async function documentOfRow(
  ctx: VaultContext,
  row: McpServer,
): Promise<ItemDocument> {
  switch (row.kind) {
    case "wrapper":
      return wrapperDocument(ctx, row)
    case "openapi":
      return endpointDocument(ctx, row)
    case "mcp":
      return serverDocument(ctx, row)
    default:
      throw invalid(`${row.name} is not something PCP shares in a repository.`)
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

/**
 * Every shareable item of the vault, as documents: skills first, then
 * servers by short name. A row that cannot be one (an endpoint with no
 * stored schema) is left out, and listed in `skipped` with why. Two that
 * would be at one path are refused (layout.ts).
 */
export async function localItems(
  ctx: VaultContext,
  skipped: Array<{ id: string; name: string; message: string }> = [],
): Promise<LocalItem[]> {
  const skills = (await listSkills(ctx)).map((entry) => ({
    id: entry.id,
    document: skillDocument(entry) as ItemDocument,
  }))
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: { in: [...SERVER_KINDS] } },
    orderBy: { slug: "asc" },
  })
  const servers: LocalItem[] = []

  for (const row of rows) {
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
 * What in the vault has a repository item's name: a skill by its name, a
 * server, endpoint or wrapper by its short name; null when nothing does.
 * `kind` is what the row is as an item (a wrapper's kind is the one asked
 * about, flow or not), or null when the name is something PCP never shares
 * (a mail account, say): applying the item then is refused for its name.
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

  const row = await db().mcpServer.findUnique({
    where: { vaultId_slug: { vaultId: ctx.vaultId, slug: ref.name } },
    select: { id: true, kind: true },
  })

  if (!row) {
    return null
  }

  const kind: ItemKind | null =
    row.kind === "mcp"
      ? "server"
      : row.kind === "openapi"
        ? "endpoint"
        : row.kind === "wrapper"
          ? ref.kind === "flow"
            ? "flow"
            : "wrapper"
          : null

  return { id: row.id, kind }
}
