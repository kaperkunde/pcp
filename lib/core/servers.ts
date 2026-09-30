import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
  SECRET_PLACEHOLDER,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import { deleteManagedSecret } from "./secrets"

/**
 * The registry of MCP servers a vault can reach, and how each one is
 * authenticated to. Talking to them is lib/core/upstream.ts.
 */

export type AuthType = "none" | "header" | "oauth"

export type ServerStatus = "unknown" | "ok" | "auth_required" | "error"

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
  oauthScope?: string | null
}

export type ServerSummary = {
  id: string
  name: string
  slug: string
  description: string
  url: string
  enabled: boolean
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

async function normalizeInput(ctx: VaultContext, input: ServerInput) {
  const name = input.name.trim()

  if (!name) {
    throw invalid("Enter a name.")
  }

  if (name.length > 80) {
    throw invalid("Keep the name under 80 characters.")
  }

  const url = validateServerUrl(input.url)
  const description = (input.description ?? "").trim().slice(0, 1000)

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
  }

  switch (input.authType) {
    case "none":
      break
    case "header": {
      if (!input.authSecretId) {
        throw invalid("Choose the secret to send.")
      }

      await requireTextSecret(ctx, input.authSecretId)
      data.authSecretId = input.authSecretId
      data.authHeaderName = validateHeaderName(
        input.authHeaderName?.trim() || DEFAULT_HEADER_NAME,
      )
      const template = input.authValueTemplate?.trim() || DEFAULT_VALUE_TEMPLATE

      if (!template.includes(SECRET_PLACEHOLDER)) {
        throw invalid(`The header value must contain ${SECRET_PLACEHOLDER}.`)
      }

      if (/[\r\n]/.test(template)) {
        throw invalid("The header value cannot span lines.")
      }

      data.authValueTemplate = template
      break
    }
    case "oauth": {
      data.oauthClientId = input.oauthClientId?.trim() || null
      data.oauthScope = input.oauthScope?.trim() || null

      if (input.oauthClientSecretId) {
        if (!data.oauthClientId) {
          throw invalid("A client secret needs a client ID to go with it.")
        }

        await requireTextSecret(ctx, input.oauthClientSecretId)
        data.oauthClientSecretId = input.oauthClientSecretId
      }
      break
    }
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

async function uniqueSlug(vaultId: string, base: string, exceptId?: string) {
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
  name: string
  slug: string
  description: string
  url: string
  enabled: boolean
  authType: string
  status: string
  statusMessage: string
  lastSyncedAt: Date | null
  oauthConnectedAt: Date | null
  _count: { tools: number }
}): ServerSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    url: row.url,
    enabled: row.enabled,
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

export async function updateServer(
  ctx: VaultContext,
  id: string,
  input: ServerInput,
): Promise<void> {
  const existing = await getServer(ctx, id)
  const data = await normalizeInput(ctx, input)

  // Switching away from OAuth, or to a different client, drops the tokens
  // PCP obtained: they belong to the old configuration.
  const dropTokens =
    existing.oauthTokensId !== null &&
    (data.authType !== "oauth" ||
      data.url !== existing.url ||
      data.oauthClientId !== existing.oauthClientId)

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
