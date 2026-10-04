import type { McpServer } from "@/lib/generated/prisma/client"

import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
  MAX_AUTH_HEADERS,
  NEW_SECRET,
  SECRET_PLACEHOLDER,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import { normalizeAuthorizeParams } from "./oauth-client"
import {
  checkNewSecret,
  createSecret,
  createSecretNamedAfter,
  deleteManagedSecret,
  deleteSecret,
  validateSecretValue,
} from "./secrets"

/**
 * The registry of servers a vault can reach, and how each one is
 * authenticated to. A server is either an MCP server or an API endpoint
 * (kind "openapi", lib/core/endpoints.ts). Talking to them is
 * lib/core/upstream.ts.
 */

export type AuthType = "none" | "header" | "oauth"

export type ServerKind = "mcp" | "openapi"

/**
 * client_required: an OAuth server that does not let PCP register itself,
 * and the owner has not given it a client yet. refused: the server turned
 * PCP down (401 or 403) with the credentials it has.
 */
export type ServerStatus =
  "unknown" | "ok" | "auth_required" | "client_required" | "refused" | "error"

/**
 * A further header carrying a secret, sent with the first one, for a server
 * that wants several at once (a key and a secret key, each in its own
 * header). Stored in server_auth_header.
 */
export type ExtraAuthHeader = {
  secretId: string
  headerName: string
  valueTemplate: string
}

/** An extra header as a form or an assistant gives it. */
export type ExtraAuthHeaderInput = {
  secretId?: string | null
  headerName?: string | null
  /** Default {{secret}}: the secret as it is. */
  valueTemplate?: string | null
}

export type ServerInput = {
  name: string
  url: string
  description?: string
  authType: AuthType
  authHeaderName?: string | null
  authValueTemplate?: string | null
  /** A secret's id, or NEW_SECRET for one typed into the form. */
  authSecretId?: string | null
  /** With NEW_SECRET: what to call it; empty names it after the server. */
  authSecretName?: string | null
  /** With NEW_SECRET: its value, saved as a new secret. */
  authSecretValue?: string | null
  /**
   * Header auth: headers sent with the first, each with a secret the owner
   * already stored.
   */
  authExtraHeaders?: ExtraAuthHeaderInput[] | null
  oauthClientId?: string | null
  oauthClientSecretId?: string | null
  /** A client secret typed into the form: stored as a new secret. */
  oauthClientSecretValue?: string | null
  oauthScope?: string | null
  oauthAuthorizeParams?: string | null
}

export type ServerSummary = {
  id: string
  kind: ServerKind
  name: string
  slug: string
  description: string
  url: string
  enabled: boolean
  readOnly: boolean
  specSource: "url" | "upload" | null
  specUrl: string | null
  authType: AuthType
  status: ServerStatus
  statusMessage: string
  lastSyncedAt: Date | null
  toolCount: number
  connected: boolean
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)

  return slug || "server"
}

export function renderAuthValue(template: string, secret: string): string {
  return template.split(SECRET_PLACEHOLDER).join(secret)
}

export function validateServerUrl(raw: string): string {
  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    throw invalid(
      "Enter the server's full address, like https://mcp.example.com/mcp.",
    )
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid(
      "The address must start with https:// (or http:// on a private network).",
    )
  }

  return url.toString()
}

function validateHeaderName(name: string): string {
  const trimmed = name.trim()

  if (!/^[A-Za-z0-9-]{1,100}$/.test(trimmed)) {
    throw invalid("Header names use letters, digits and dashes only.")
  }

  return trimmed
}

export function normalizeNameAndDescription(input: {
  name: string
  description?: string
}): { name: string; description: string } {
  const name = input.name.trim()

  if (!name) {
    throw invalid("Enter a name.")
  }

  if (name.length > 80) {
    throw invalid("Keep the name under 80 characters.")
  }

  // The name is shown to every assistant in the gateway's instructions: a
  // line break there would let it start a line of its own.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid("The name cannot have line breaks or control characters.")
  }

  return { name, description: (input.description ?? "").trim().slice(0, 1000) }
}

/** A secret typed into a form, saved when the row that sends it is. */
export type NewSecret = {
  /** The name given; null names it after what sends it. */
  name: string | null
  /** What a name made up for it starts with. */
  base: string
  value: string
  description: string
}

export type HeaderAuth = {
  /** Null while newSecret is still to be saved. */
  authSecretId: string | null
  authHeaderName: string
  authValueTemplate: string
  /** Sent with the first header, in this order. */
  authExtraHeaders: ExtraAuthHeader[]
  newSecret: NewSecret | null
}

function validateValueTemplate(template: string): string {
  if (!template.includes(SECRET_PLACEHOLDER)) {
    throw invalid(`The header value must contain ${SECRET_PLACEHOLDER}.`)
  }

  if (/[\r\n]/.test(template)) {
    throw invalid("The header value cannot span lines.")
  }

  return template
}

/**
 * The headers sent with the first, each with a secret the owner stored.
 * Every part of a credential is a secret PCP sends, so none is ever left for
 * an assistant to pass as an argument.
 */
async function normalizeExtraHeaders(
  ctx: VaultContext,
  first: string,
  given: ExtraAuthHeaderInput[],
): Promise<ExtraAuthHeader[]> {
  if (given.length + 1 > MAX_AUTH_HEADERS) {
    throw invalid(
      `A server can be sent at most ${MAX_AUTH_HEADERS} headers with secrets.`,
    )
  }

  const names = new Set([first.toLowerCase()])
  const extras: ExtraAuthHeader[] = []

  for (const extra of given) {
    if (!extra.secretId || extra.secretId === NEW_SECRET) {
      throw invalid("Choose a stored secret to send in each header.")
    }

    if (!extra.headerName?.trim()) {
      throw invalid("Name each header a secret is sent in.")
    }

    await requireTextSecret(ctx, extra.secretId)
    const headerName = validateHeaderName(extra.headerName)

    if (names.has(headerName.toLowerCase())) {
      throw invalid(`The ${headerName} header is named twice.`)
    }

    names.add(headerName.toLowerCase())
    extras.push({
      secretId: extra.secretId,
      headerName,
      valueTemplate: validateValueTemplate(
        extra.valueTemplate?.trim() || SECRET_PLACEHOLDER,
      ),
    })
  }

  return extras
}

/**
 * Header authentication: which secret, in which header, in what form, and
 * the further headers sent with it. A secret typed into the form is checked
 * here with everything else and saved by saveNewSecret just before the row
 * that sends it, so a form refused for another reason leaves no secret
 * behind.
 */
export async function normalizeHeaderAuth(
  ctx: VaultContext,
  input: Pick<
    ServerInput,
    | "authSecretId"
    | "authHeaderName"
    | "authValueTemplate"
    | "authSecretName"
    | "authSecretValue"
    | "authExtraHeaders"
  >,
  sender: { name: string },
): Promise<HeaderAuth> {
  if (!input.authSecretId) {
    throw invalid("Choose the secret to send, or enter a new one.")
  }

  const authHeaderName = validateHeaderName(
    input.authHeaderName?.trim() || DEFAULT_HEADER_NAME,
  )
  const template = validateValueTemplate(
    input.authValueTemplate?.trim() || DEFAULT_VALUE_TEMPLATE,
  )
  const authExtraHeaders = await normalizeExtraHeaders(
    ctx,
    authHeaderName,
    input.authExtraHeaders ?? [],
  )

  let newSecret: NewSecret | null = null

  if (input.authSecretId === NEW_SECRET) {
    const value = input.authSecretValue ?? ""
    const name = input.authSecretName?.trim() || null
    const description = `Sent to ${sender.name} in the ${authHeaderName} header.`

    if (name) {
      await checkNewSecret(ctx, { name, value })
    } else {
      const problem = validateSecretValue(value)

      if (problem) {
        throw invalid(problem)
      }
    }

    newSecret = { name, base: `${sender.name} key`, value, description }
  } else {
    await requireTextSecret(ctx, input.authSecretId)
  }

  return {
    authSecretId: newSecret ? null : input.authSecretId,
    authHeaderName,
    authValueTemplate: template,
    authExtraHeaders,
    newSecret,
  }
}

/** A server's further secret headers, in the order they are sent. */
export async function extraAuthHeaders(
  serverId: string,
): Promise<ExtraAuthHeader[]> {
  const rows = await db().serverAuthHeader.findMany({
    where: { serverId },
    orderBy: { position: "asc" },
    select: { secretId: true, headerName: true, valueTemplate: true },
  })

  return rows.map((row) => ({ ...row, secretId: row.secretId ?? "" }))
}

/**
 * Every header a server's credential goes in: a secret's headers, or the
 * one an OAuth endpoint's token goes in; none without a credential. An
 * assistant's argument may never set one of them.
 */
export async function authHeaderNames(
  server: Pick<McpServer, "id" | "authType" | "authHeaderName">,
): Promise<string[]> {
  if (!server.authHeaderName) {
    return []
  }

  const extras =
    server.authType === "header" ? await extraAuthHeaders(server.id) : []
  return [server.authHeaderName, ...extras.map((extra) => extra.headerName)]
}

/**
 * The nested write that makes a server's further headers these. `replace`
 * removes the ones it had first (an update; a new row has none).
 */
export function extraAuthHeadersWrite(
  extras: ExtraAuthHeader[],
  { replace }: { replace: boolean },
) {
  const create = extras.map((extra, index) => ({
    id: newId(),
    position: index + 1,
    ...extra,
  }))

  return replace ? { deleteMany: {}, create } : { create }
}

/** Saves a secret typed into a form; its id, and the name it got. */
export async function saveNewSecret(
  ctx: VaultContext,
  secret: NewSecret,
): Promise<{ id: string; name: string }> {
  if (secret.name) {
    const { id } = await createSecret(ctx, {
      name: secret.name,
      value: secret.value,
      description: secret.description,
    })

    return { id, name: secret.name }
  }

  return createSecretNamedAfter(ctx, {
    base: secret.base,
    value: secret.value,
    description: secret.description,
  })
}

/**
 * Writes a row that sends a secret typed into the form: the secret is saved
 * first, and removed again when the write fails, so nothing is left that the
 * owner did not end up with.
 */
export async function withNewSecret<T>(
  ctx: VaultContext,
  secret: NewSecret | null,
  write: (secretId: string | null) => Promise<T>,
): Promise<T> {
  if (!secret) {
    return write(null)
  }

  const { id } = await saveNewSecret(ctx, secret)

  try {
    return await write(id)
  } catch (error) {
    await deleteSecret(ctx, id).catch(() => {})
    throw error
  }
}

export type OAuthClientFields = {
  oauthClientId: string | null
  /** Null while newSecret is still to be saved. */
  oauthClientSecretId: string | null
  oauthScope: string | null
  oauthAuthorizeParams: string | null
  newSecret: NewSecret | null
}

/**
 * The OAuth client the owner created with a provider, its scope and extra
 * sign-in parameters, for an MCP server or an API endpoint. A client secret
 * typed into a form becomes one of the owner's own secrets (so another server
 * that signs in with the same client can pick it, and it can be rotated on
 * the Secrets page), saved by withNewSecret with the row, like a header's.
 */
export async function normalizeOAuthClient(
  ctx: VaultContext,
  input: Pick<
    ServerInput,
    | "oauthClientId"
    | "oauthClientSecretId"
    | "oauthClientSecretValue"
    | "oauthScope"
    | "oauthAuthorizeParams"
  >,
  sender: { name: string },
): Promise<OAuthClientFields> {
  const oauthClientId = input.oauthClientId?.trim() || null
  const oauthScope = input.oauthScope?.trim() || null

  if (oauthClientId && oauthClientId.length > 500) {
    throw invalid("That client ID is too long.")
  }

  if (oauthScope && (oauthScope.length > 4000 || /[\r\n]/.test(oauthScope))) {
    throw invalid("The scope is too long, or spans lines.")
  }

  const typedSecret = input.oauthClientSecretValue?.trim()

  if ((typedSecret || input.oauthClientSecretId) && !oauthClientId) {
    throw invalid("A client secret needs a client ID to go with it.")
  }

  let newSecret: NewSecret | null = null
  let oauthClientSecretId: string | null = null

  if (typedSecret) {
    const problem = validateSecretValue(typedSecret)

    if (problem) {
      throw invalid(problem)
    }

    newSecret = {
      name: null,
      base: `${sender.name} OAuth client secret`,
      value: typedSecret,
      description: `Client secret for the OAuth client ${oauthClientId}.`,
    }
  } else if (input.oauthClientSecretId) {
    await requireTextSecret(ctx, input.oauthClientSecretId)
    oauthClientSecretId = input.oauthClientSecretId
  }

  return {
    oauthClientId,
    oauthClientSecretId,
    oauthScope,
    oauthAuthorizeParams: normalizeAuthorizeParams(input.oauthAuthorizeParams),
    newSecret,
  }
}

/** Where a secret saved by withNewSecret goes: the header's, or the client's. */
export function secretColumns(
  data: {
    authType: string
    authSecretId: string | null
    oauthClientSecretId: string | null
  },
  secretId: string | null,
): { authSecretId: string | null; oauthClientSecretId: string | null } {
  return data.authType === "oauth"
    ? {
        authSecretId: data.authSecretId,
        oauthClientSecretId: secretId ?? data.oauthClientSecretId,
      }
    : {
        authSecretId: secretId ?? data.authSecretId,
        oauthClientSecretId: data.oauthClientSecretId,
      }
}

async function normalizeInput(ctx: VaultContext, input: ServerInput) {
  const { name, description } = normalizeNameAndDescription(input)
  const url = validateServerUrl(input.url)

  const data = {
    name,
    url,
    description,
    authType: input.authType,
    authHeaderName: null as string | null,
    authValueTemplate: null as string | null,
    authSecretId: null as string | null,
    oauthClientId: null as string | null,
    oauthClientSecretId: null as string | null,
    oauthScope: null as string | null,
    oauthAuthorizeParams: null as string | null,
  }
  let authExtraHeaders: ExtraAuthHeader[] = []
  let newSecret: NewSecret | null = null

  switch (input.authType) {
    case "none":
      break
    case "header": {
      const auth = await normalizeHeaderAuth(ctx, input, { name })
      data.authSecretId = auth.authSecretId
      data.authHeaderName = auth.authHeaderName
      data.authValueTemplate = auth.authValueTemplate
      authExtraHeaders = auth.authExtraHeaders
      newSecret = auth.newSecret
      break
    }
    case "oauth": {
      const client = await normalizeOAuthClient(ctx, input, { name })
      data.oauthClientId = client.oauthClientId
      data.oauthClientSecretId = client.oauthClientSecretId
      data.oauthScope = client.oauthScope
      data.oauthAuthorizeParams = client.oauthAuthorizeParams
      newSecret = client.newSecret
      break
    }
    default:
      throw invalid("Unknown authentication type.")
  }

  return { data, authExtraHeaders, newSecret }
}

async function requireTextSecret(ctx: VaultContext, id: string) {
  const secret = await db().secret.findFirst({
    where: { id, vaultId: ctx.vaultId, kind: "text" },
    select: { id: true },
  })

  if (!secret) {
    throw invalid("That secret does not exist.")
  }
}

export async function uniqueSlug(
  vaultId: string,
  base: string,
  exceptId?: string,
) {
  let slug = base

  for (let n = 2; ; n++) {
    const clash = await db().mcpServer.findUnique({
      where: { vaultId_slug: { vaultId, slug } },
      select: { id: true },
    })

    if (!clash || clash.id === exceptId) {
      return slug
    }

    slug = `${base}-${n}`
  }
}

function summarize(row: {
  id: string
  kind: string
  name: string
  slug: string
  description: string
  url: string
  enabled: boolean
  readOnly: boolean
  specSource: string | null
  specUrl: string | null
  authType: string
  status: string
  statusMessage: string
  lastSyncedAt: Date | null
  oauthConnectedAt: Date | null
  _count: { tools: number }
}): ServerSummary {
  return {
    id: row.id,
    kind: row.kind === "openapi" ? "openapi" : "mcp",
    name: row.name,
    slug: row.slug,
    description: row.description,
    url: row.url,
    enabled: row.enabled,
    readOnly: row.readOnly,
    specSource:
      row.specSource === "url" || row.specSource === "upload"
        ? row.specSource
        : null,
    specUrl: row.specUrl,
    authType: row.authType as AuthType,
    status: row.status as ServerStatus,
    statusMessage: row.statusMessage,
    lastSyncedAt: row.lastSyncedAt,
    toolCount: row._count.tools,
    connected: row.authType !== "oauth" || row.oauthConnectedAt !== null,
  }
}

export async function listServers(ctx: VaultContext): Promise<ServerSummary[]> {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId },
    include: { _count: { select: { tools: true } } },
    orderBy: { name: "asc" },
  })

  return rows.map(summarize)
}

export async function getServer(ctx: VaultContext, id: string) {
  const row = await db().mcpServer.findFirst({
    where: { id, vaultId: ctx.vaultId },
    include: {
      tools: { orderBy: { name: "asc" } },
      _count: { select: { tools: true } },
    },
  })

  if (!row) {
    throw notFound("That server")
  }

  return row
}

export async function getServerBySlug(ctx: VaultContext, slug: string) {
  return db().mcpServer.findUnique({
    where: { vaultId_slug: { vaultId: ctx.vaultId, slug } },
  })
}

export async function createServer(
  ctx: VaultContext,
  input: ServerInput,
): Promise<{ id: string }> {
  const { data, authExtraHeaders, newSecret } = await normalizeInput(ctx, input)
  const id = newId()

  await withNewSecret(ctx, newSecret, async (secretId) =>
    db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        slug: await uniqueSlug(ctx.vaultId, slugify(data.name)),
        ...data,
        ...secretColumns(data, secretId),
        authHeaders: extraAuthHeadersWrite(authExtraHeaders, {
          replace: false,
        }),
      },
    }),
  )

  return { id }
}

/** What reaching a server depends on; a change to any can change its tools. */
const CONNECTION_FIELDS = [
  "url",
  "authType",
  "authHeaderName",
  "authValueTemplate",
  "authSecretId",
  "oauthClientId",
  "oauthClientSecretId",
  "oauthScope",
] as const

/**
 * Saves a server's settings. `reconnect` says its address or credentials
 * changed, so the tools stored for it may no longer be the ones it has.
 */
export async function updateServer(
  ctx: VaultContext,
  id: string,
  input: ServerInput,
): Promise<{ reconnect: boolean }> {
  const existing = await getServer(ctx, id)

  if (existing.kind !== "mcp") {
    throw new PcpError(
      "state",
      "This is an API endpoint; change it in its own settings.",
    )
  }

  const { data, authExtraHeaders, newSecret } = await normalizeInput(ctx, input)
  const extrasBefore = await extraAuthHeaders(id)

  // Switching away from OAuth, or to a different client, drops the tokens
  // PCP obtained: they belong to the old configuration.
  const dropTokens =
    existing.oauthTokensId !== null &&
    (data.authType !== "oauth" ||
      data.url !== existing.url ||
      data.oauthClientId !== existing.oauthClientId)

  await withNewSecret(ctx, newSecret, async (secretId) => {
    Object.assign(data, secretColumns(data, secretId))
    await db().mcpServer.update({
      where: { id },
      data: {
        ...data,
        authHeaders: extraAuthHeadersWrite(authExtraHeaders, {
          replace: true,
        }),
        ...(dropTokens
          ? { oauthTokensId: null, oauthConnectedAt: null, status: "unknown" }
          : {}),
      },
    })
  })

  if (dropTokens && existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }

  return {
    reconnect:
      CONNECTION_FIELDS.some((key) => data[key] !== existing[key]) ||
      JSON.stringify(authExtraHeaders) !== JSON.stringify(extrasBefore),
  }
}

/**
 * Gives an OAuth server or endpoint the client the owner created with the
 * provider, keeping every other setting: what its page asks for when it
 * does not let PCP register itself. The client ID is required here, since
 * without one it still cannot be connected; a secret left out keeps the one
 * it has.
 */
export async function setOAuthClient(
  ctx: VaultContext,
  id: string,
  client: {
    clientId: string
    clientSecretId?: string | null
    clientSecretValue?: string | null
  },
): Promise<void> {
  const existing = await getServer(ctx, id)

  if (!client.clientId.trim()) {
    throw invalid("Enter the client ID.")
  }

  await writeOAuthClient(ctx, existing, {
    oauthClientId: client.clientId,
    oauthClientSecretId:
      client.clientSecretId === undefined
        ? existing.oauthClientSecretId
        : client.clientSecretId,
    oauthClientSecretValue: client.clientSecretValue ?? null,
    oauthScope: existing.oauthScope,
    oauthAuthorizeParams: existing.oauthAuthorizeParams,
  })
}

/**
 * Sets only an OAuth server's extra sign-in parameters: what its page asks
 * for when a sign-in gave PCP access it cannot renew. They take effect on the
 * next sign-in; the current one stays until then.
 */
export async function setOAuthSignInParams(
  ctx: VaultContext,
  id: string,
  params: string,
): Promise<void> {
  const existing = await getServer(ctx, id)

  await writeOAuthClient(ctx, existing, {
    oauthClientId: existing.oauthClientId,
    oauthClientSecretId: existing.oauthClientSecretId,
    oauthScope: existing.oauthScope,
    oauthAuthorizeParams: params,
  })
}

/**
 * Writes the OAuth client columns and nothing else, for either kind of
 * server. A different client drops the tokens PCP holds: they belong to the
 * old one.
 */
async function writeOAuthClient(
  ctx: VaultContext,
  existing: Awaited<ReturnType<typeof getServer>>,
  input: Parameters<typeof normalizeOAuthClient>[1],
): Promise<void> {
  if (existing.authType !== "oauth") {
    throw new PcpError("state", `${existing.name} does not use OAuth.`)
  }

  const { newSecret, ...client } = await normalizeOAuthClient(
    ctx,
    input,
    existing,
  )
  const dropTokens =
    existing.oauthTokensId !== null &&
    client.oauthClientId !== existing.oauthClientId

  await withNewSecret(ctx, newSecret, (secretId) =>
    db().mcpServer.update({
      where: { id: existing.id },
      data: {
        ...client,
        oauthClientSecretId: secretId ?? client.oauthClientSecretId,
        ...(dropTokens
          ? { oauthTokensId: null, oauthConnectedAt: null, status: "unknown" }
          : {}),
      },
    }),
  )

  if (dropTokens && existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }
}

export async function renameServerSlug(
  ctx: VaultContext,
  id: string,
  slug: string,
): Promise<void> {
  await getServer(ctx, id)
  const cleaned = slugify(slug)

  if (cleaned !== slug.trim()) {
    throw invalid(
      "Use lowercase letters, digits and dashes for the short name.",
    )
  }

  const clash = await db().mcpServer.findUnique({
    where: { vaultId_slug: { vaultId: ctx.vaultId, slug: cleaned } },
    select: { id: true },
  })

  if (clash && clash.id !== id) {
    throw new PcpError(
      "conflict",
      `Another server is already called ${cleaned}.`,
    )
  }

  await db().mcpServer.update({ where: { id }, data: { slug: cleaned } })
}

export async function setServerEnabled(
  ctx: VaultContext,
  id: string,
  enabled: boolean,
): Promise<void> {
  await getServer(ctx, id)
  await db().mcpServer.update({ where: { id }, data: { enabled } })
}

export async function deleteServer(ctx: VaultContext, id: string) {
  const existing = await getServer(ctx, id)
  await db().mcpServer.delete({ where: { id } })

  if (existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }
}

export async function setToolDescription(
  ctx: VaultContext,
  serverId: string,
  toolName: string,
  override: string | null,
): Promise<void> {
  await getServer(ctx, serverId)
  const trimmed = override?.trim().slice(0, 2000) || null

  await db().mcpTool.update({
    where: { serverId_name: { serverId, name: toolName } },
    data: { descriptionOverride: trimmed },
  })
}

export async function setServerStatus(
  serverId: string,
  status: ServerStatus,
  message = "",
  extra: { lastSyncedAt?: Date } = {},
): Promise<void> {
  await db().mcpServer.update({
    where: { id: serverId },
    data: { status, statusMessage: message.slice(0, 500), ...extra },
  })
}
