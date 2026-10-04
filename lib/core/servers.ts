import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
  SECRET_PLACEHOLDER,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import { normalizeAuthorizeParams } from "./oauth-client"
import { createSecretNamedAfter, deleteManagedSecret } from "./secrets"

/**
 * The registry of servers a vault can reach, and how each one is
 * authenticated to. A server is an MCP server, an API endpoint (kind
 * "openapi", lib/core/endpoints.ts) or a mail account (kinds "jmap" and
 * "imap", lib/core/mail/). Talking to them is lib/core/upstream.ts.
 */

/** basic: a user name and a secret (a mail account's login). */
export type AuthType = "none" | "header" | "oauth" | "basic"

export type ServerKind = "mcp" | "openapi" | "jmap" | "imap"

export type MailKind = Extract<ServerKind, "jmap" | "imap">

const SERVER_KINDS: readonly ServerKind[] = ["mcp", "openapi", "jmap", "imap"]

/** A mail account rather than an MCP server or an API endpoint. */
export function isMailKind(kind: string): kind is MailKind {
  return kind === "jmap" || kind === "imap"
}

/** What a kind is called in a sentence: "an API endpoint". */
export function kindNoun(kind: string): string {
  switch (asServerKind(kind)) {
    case "openapi":
      return "an API endpoint"
    case "jmap":
    case "imap":
      return "a mail account"
    default:
      return "an MCP server"
  }
}

/** A row's kind; anything unknown reads as an MCP server, the default. */
export function asServerKind(value: string): ServerKind {
  return (SERVER_KINDS as readonly string[]).includes(value)
    ? (value as ServerKind)
    : "mcp"
}

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
  authSecretId?: string | null
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

/** Header authentication: which secret, in which header, in what form. */
export async function normalizeHeaderAuth(
  ctx: VaultContext,
  input: Pick<
    ServerInput,
    "authSecretId" | "authHeaderName" | "authValueTemplate"
  >,
): Promise<{
  authSecretId: string
  authHeaderName: string
  authValueTemplate: string
}> {
  if (!input.authSecretId) {
    throw invalid("Choose the secret to send.")
  }

  await requireTextSecret(ctx, input.authSecretId)
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

  return {
    authSecretId: input.authSecretId,
    authHeaderName,
    authValueTemplate: template,
  }
}

/**
 * Basic authentication: a user name and the secret that goes with it, sent
 * together (a JMAP server's Basic authentication, an IMAP or SMTP login).
 */
export async function normalizeBasicAuth(
  ctx: VaultContext,
  input: { authUsername?: string | null; authSecretId?: string | null },
): Promise<{ authUsername: string; authSecretId: string }> {
  const authUsername = input.authUsername?.trim() ?? ""

  if (!authUsername) {
    throw invalid("Enter the user name to sign in with.")
  }

  if (authUsername.length > 320) {
    throw invalid("That user name is too long.")
  }

  // Basic authentication joins the name and the password with a colon, and
  // a login line ends at a line break: either would change what is sent.
  if (/[\u0000-\u001f\u007f:]/.test(authUsername)) {
    throw invalid(
      "The user name cannot have a colon, line breaks or control characters.",
    )
  }

  if (!input.authSecretId) {
    throw invalid("Choose the secret that holds the password.")
  }

  await requireTextSecret(ctx, input.authSecretId)

  return { authUsername, authSecretId: input.authSecretId }
}

export type OAuthClientInput = Pick<
  ServerInput,
  | "oauthClientId"
  | "oauthClientSecretId"
  | "oauthClientSecretValue"
  | "oauthScope"
  | "oauthAuthorizeParams"
>

/**
 * OAuth settings: the owner's own client, if they have one, and what the
 * sign-in asks for. A client secret typed into the form becomes one of the
 * owner's secrets, named after the server.
 */
export async function normalizeOAuthClient(
  ctx: VaultContext,
  input: OAuthClientInput,
  serverName: string,
): Promise<{
  oauthClientId: string | null
  oauthClientSecretId: string | null
  oauthScope: string | null
  oauthAuthorizeParams: string | null
}> {
  const oauthClientId = input.oauthClientId?.trim() || null
  const data = {
    oauthClientId,
    oauthClientSecretId: null as string | null,
    oauthScope: input.oauthScope?.trim() || null,
    oauthAuthorizeParams: normalizeAuthorizeParams(input.oauthAuthorizeParams),
  }

  if (oauthClientId && oauthClientId.length > 500) {
    throw invalid("That client ID is too long.")
  }

  const typedSecret = input.oauthClientSecretValue?.trim()

  if (typedSecret || input.oauthClientSecretId) {
    if (!oauthClientId) {
      throw invalid("A client secret needs a client ID to go with it.")
    }
  }

  if (typedSecret) {
    // Kept as one of the owner's own secrets, so another server that
    // signs in with the same client can pick it, and it can be rotated
    // on the Secrets page.
    const { id } = await createSecretNamedAfter(ctx, {
      base: `${serverName} OAuth client secret`,
      value: typedSecret,
      description: `Client secret for the OAuth client ${oauthClientId}.`,
    })
    data.oauthClientSecretId = id
  } else if (input.oauthClientSecretId) {
    await requireTextSecret(ctx, input.oauthClientSecretId)
    data.oauthClientSecretId = input.oauthClientSecretId
  }

  return data
}

/**
 * Whether the OAuth tokens PCP holds for a server belong to a configuration
 * it no longer has: it stopped using OAuth, moved, or signs in with another
 * client. They are dropped then.
 */
export function oauthTokensObsolete(
  existing: {
    oauthTokensId: string | null
    url: string
    oauthClientId: string | null
  },
  next: { authType: string; url: string; oauthClientId: string | null },
): boolean {
  return (
    existing.oauthTokensId !== null &&
    (next.authType !== "oauth" ||
      next.url !== existing.url ||
      next.oauthClientId !== existing.oauthClientId)
  )
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

  switch (input.authType) {
    case "none":
      break
    case "header":
      Object.assign(data, await normalizeHeaderAuth(ctx, input))
      break
    case "oauth":
      Object.assign(data, await normalizeOAuthClient(ctx, input, name))
      break
    default:
      throw invalid("Unknown authentication type.")
  }

  return data
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
    kind: asServerKind(row.kind),
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
  const data = await normalizeInput(ctx, input)
  const id = newId()

  await db().mcpServer.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      slug: await uniqueSlug(ctx.vaultId, slugify(data.name)),
      ...data,
    },
  })

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
      `This is ${kindNoun(existing.kind)}; change it in its own settings.`,
    )
  }

  const data = await normalizeInput(ctx, input)

  // Switching away from OAuth, or to a different client, drops the tokens
  // PCP obtained: they belong to the old configuration.
  const dropTokens = oauthTokensObsolete(existing, data)

  await db().mcpServer.update({
    where: { id },
    data: {
      ...data,
      ...(dropTokens
        ? { oauthTokensId: null, oauthConnectedAt: null, status: "unknown" }
        : {}),
    },
  })

  if (dropTokens && existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }

  return {
    reconnect: CONNECTION_FIELDS.some((key) => data[key] !== existing[key]),
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
