import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
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
 * and the owner has not given it a client yet.
 */
export type ServerStatus =
  "unknown" | "ok" | "auth_required" | "client_required" | "error"

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
  newSecret: NewSecret | null
}

/**
 * Header authentication: which secret, in which header, in what form. A
 * secret typed into the form is checked here with everything else and saved
 * by saveNewSecret just before the row that sends it, so a form refused for
 * another reason leaves no secret behind.
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
  >,
  sender: { name: string },
): Promise<HeaderAuth> {
  if (!input.authSecretId) {
    throw invalid("Choose the secret to send, or enter a new one.")
  }

  const authHeaderName = validateHeaderName(
    input.authHeaderName?.trim() || DEFAULT_HEADER_NAME,
  )
  const template = input.authValueTemplate?.trim() || DEFAULT_VALUE_TEMPLATE

  if (!template.includes(SECRET_PLACEHOLDER)) {
    throw invalid(`The header value must contain ${SECRET_PLACEHOLDER}.`)
  }

  if (/[\r\n]/.test(template)) {
    throw invalid("The header value cannot span lines.")
  }

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
    newSecret,
  }
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
  let newSecret: NewSecret | null = null

  switch (input.authType) {
    case "none":
      break
    case "header": {
      const auth = await normalizeHeaderAuth(ctx, input, { name })
      data.authSecretId = auth.authSecretId
      data.authHeaderName = auth.authHeaderName
      data.authValueTemplate = auth.authValueTemplate
      newSecret = auth.newSecret
      break
    }
    case "oauth": {
      data.oauthClientId = input.oauthClientId?.trim() || null
      data.oauthScope = input.oauthScope?.trim() || null
      data.oauthAuthorizeParams = normalizeAuthorizeParams(
        input.oauthAuthorizeParams,
      )

      if (data.oauthClientId && data.oauthClientId.length > 500) {
        throw invalid("That client ID is too long.")
      }

      const typedSecret = input.oauthClientSecretValue?.trim()

      if (typedSecret || input.oauthClientSecretId) {
        if (!data.oauthClientId) {
          throw invalid("A client secret needs a client ID to go with it.")
        }
      }

      if (typedSecret) {
        // Kept as one of the owner's own secrets, so another server that
        // signs in with the same client can pick it, and it can be rotated
        // on the Secrets page.
        const { id } = await createSecretNamedAfter(ctx, {
          base: `${name} OAuth client secret`,
          value: typedSecret,
          description: `Client secret for the OAuth client ${data.oauthClientId}.`,
        })
        data.oauthClientSecretId = id
      } else if (input.oauthClientSecretId) {
        await requireTextSecret(ctx, input.oauthClientSecretId)
        data.oauthClientSecretId = input.oauthClientSecretId
      }
      break
    }
    default:
      throw invalid("Unknown authentication type.")
  }

  return { data, newSecret }
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
  const { data, newSecret } = await normalizeInput(ctx, input)
  const id = newId()

  await withNewSecret(ctx, newSecret, async (secretId) =>
    db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        slug: await uniqueSlug(ctx.vaultId, slugify(data.name)),
        ...data,
        authSecretId: secretId ?? data.authSecretId,
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

  const { data, newSecret } = await normalizeInput(ctx, input)

  // Switching away from OAuth, or to a different client, drops the tokens
  // PCP obtained: they belong to the old configuration.
  const dropTokens =
    existing.oauthTokensId !== null &&
    (data.authType !== "oauth" ||
      data.url !== existing.url ||
      data.oauthClientId !== existing.oauthClientId)

  await withNewSecret(ctx, newSecret, async (secretId) => {
    data.authSecretId = secretId ?? data.authSecretId
    await db().mcpServer.update({
      where: { id },
      data: {
        ...data,
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
    reconnect: CONNECTION_FIELDS.some((key) => data[key] !== existing[key]),
  }
}

/**
 * Gives an OAuth server the client the owner created with the provider,
 * keeping every other setting: what the server page asks for when the server
 * does not let PCP register itself. The client ID is required here, since
 * without one the server still cannot be connected; a secret left out keeps
 * the one it has.
 */
export async function setOAuthClient(
  ctx: VaultContext,
  id: string,
  client: {
    clientId: string
    clientSecretId?: string | null
    clientSecretValue?: string | null
  },
): Promise<{ reconnect: boolean }> {
  const existing = await getServer(ctx, id)

  if (existing.authType !== "oauth") {
    throw new PcpError("state", `${existing.name} does not use OAuth.`)
  }

  if (!client.clientId.trim()) {
    throw invalid("Enter the client ID.")
  }

  return updateServer(ctx, id, {
    name: existing.name,
    url: existing.url,
    description: existing.description,
    authType: "oauth",
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
