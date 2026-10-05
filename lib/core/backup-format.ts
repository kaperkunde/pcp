import { z } from "zod"

import type {
  ApiToken,
  ApiTokenServer,
  ApiTokenToolAccess,
  BrowserProfile,
  HostSetting,
  KeyGrant,
  McpServer,
  McpTool,
  Memory,
  OpenApiSpec,
  PermissionRequest,
  Secret,
  ServerAuthHeader,
  Setting,
  Vault,
  VaultToolAccess,
  WebFetchRule,
} from "@/lib/generated/prisma/client"

import { asBytes } from "./crypto"
import { invalid } from "./errors"
import { DDNS_CONFIG_KEY, ddnsHostname, type DdnsConfig } from "./network/ddns"
import { TLS_CONFIG_KEY } from "./network/tls"

/**
 * The shape of an export file (lib/core/backup.ts): what is in it, and the
 * checks a file goes through before anything is written from it.
 *
 * The file is a JSON envelope: the format's name and version, the scrypt
 * parameters the export password was run through, and `data`, which is
 * AES-256-GCM ciphertext (nonce || ciphertext || tag) of the gzip-compressed
 * payload. The payload is the vault's rows as they are in the database —
 * ciphertext stays ciphertext under the vault's own key, and the key itself
 * travels only wrapped, in the password, recovery and API token grants — so
 * reading it takes the export password and one of the vault's credentials,
 * and restoring it is writing rows, not re-encrypting them.
 *
 * Every row schema names every column of its table, strictly: a column the
 * running PCP does not know means the file came from a newer one, and the
 * guard at the end fails `pnpm typecheck` when a migration adds a column the
 * format does not carry yet. Add it here with a `.default(...)` (the
 * column's own), so older exports still restore. EXPORT_VERSION changes only
 * when a file could no longer be read this way.
 */

export const EXPORT_FORMAT = "pcp-export"
export const EXPORT_VERSION = 1
/** Binds the ciphertext to this format, so an envelope cannot be relabelled. */
export const EXPORT_AAD = `${EXPORT_FORMAT}:${EXPORT_VERSION}`

/** Rows per createMany on a restore: SQLite allows 999 variables a query. */
export const RESTORE_CHUNK_ROWS = 50
/** openapi_spec rows carry up to 5 MB of text each. */
export const RESTORE_SPEC_CHUNK_ROWS = 10

// ---- Scalars -------------------------------------------------------------

const str = z.string()
const id = z.string().min(1).max(200)
const iso = z.iso.datetime()
/** A column of type DateTime: an ISO string in the file, a Date in a row. */
const date = iso.transform((value) => new Date(value))
const dateOrNull = date.nullable()
/** A column of type Bytes: base64 in the file, what Prisma takes in a row. */
const bytes = z
  .base64()
  .transform((value) => asBytes(Buffer.from(value, "base64")))
const bytesOrNull = bytes.nullable()

/**
 * The scrypt parameters a file may ask for. `deriveKek` sizes its memory
 * from them, so a hostile file could otherwise ask for gigabytes; these
 * bounds allow a quarter of one.
 */
const ScryptParamsSchema = z
  .strictObject({
    kdf: z.literal("scrypt"),
    salt: z.base64().min(1),
    N: z
      .number()
      .int()
      .min(1 << 14)
      .max(1 << 20),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(4),
  })
  .refine((params) => (params.N & (params.N - 1)) === 0, {
    message: "N must be a power of two",
  })
  .refine((params) => params.N * params.r <= 1 << 20, {
    message: "N × r is too large",
  })

export const EnvelopeSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().positive(),
  kdf: ScryptParamsSchema,
  data: z.base64(),
})

// ---- Tables ---------------------------------------------------------------

const VaultRow = z.strictObject({
  id,
  name: str,
  createdAt: date,
  updatedAt: date,
})

const KeyGrantRow = z.strictObject({
  id,
  vaultId: id,
  kind: str,
  lookupHash: str.nullable(),
  kdf: str,
  kdfParams: str,
  wrappedDek: bytes,
  createdAt: date,
  lastUsedAt: dateOrNull,
})

const ApiTokenRow = z.strictObject({
  id,
  vaultId: id,
  grantId: id,
  name: str,
  prefix: str,
  allowAllServers: z.boolean(),
  manageEndpoints: z.boolean(),
  keepMemories: z.boolean(),
  webFetch: z.boolean(),
  expiresAt: dateOrNull,
  revokedAt: dateOrNull,
  createdAt: date,
  lastUsedAt: dateOrNull,
})

const ApiTokenServerRow = z.strictObject({ tokenId: id, serverId: id })

const ApiTokenToolAccessRow = z.strictObject({
  tokenId: id,
  serverId: id,
  toolName: str,
  access: str,
  updatedAt: date,
})

const VaultToolAccessRow = z.strictObject({
  vaultId: id,
  serverId: id,
  toolName: str,
  access: str,
  updatedAt: date,
})

const WebFetchRuleRow = z.strictObject({
  id,
  vaultId: id,
  tokenId: id.nullable(),
  scope: str,
  kind: str,
  key: str,
  access: str.nullable(),
  addedBy: str,
  createdAt: date,
  updatedAt: date,
  lastFetchedAt: dateOrNull,
})

const PermissionRequestRow = z.strictObject({
  id,
  vaultId: id,
  tokenId: id,
  kind: str,
  serverId: id.nullable(),
  toolName: str,
  argsCiphertext: bytes,
  argsHash: str,
  fields: str.nullable(),
  decode: str.nullable(),
  status: str,
  via: str.nullable(),
  resultCiphertext: bytesOrNull,
  resultIsError: z.boolean(),
  createdAt: date,
  expiresAt: date,
  decidedAt: dateOrNull,
})

const MemoryRow = z.strictObject({
  id,
  vaultId: id,
  tokenId: id.nullable(),
  author: str,
  visibility: str,
  always: z.boolean(),
  ciphertext: bytes,
  createdAt: date,
  updatedAt: date,
})

const SecretRow = z.strictObject({
  id,
  vaultId: id,
  name: str,
  description: str,
  kind: str,
  ciphertext: bytes,
  keyVersion: z.number().int(),
  createdAt: date,
  updatedAt: date,
  lastUsedAt: dateOrNull,
})

const McpServerRow = z.strictObject({
  id,
  vaultId: id,
  name: str,
  slug: str,
  description: str,
  url: str,
  enabled: z.boolean(),
  authType: str,
  authHeaderName: str.nullable(),
  authValueTemplate: str.nullable(),
  authSecretId: id.nullable(),
  oauthClientId: str.nullable(),
  oauthClientSecretId: id.nullable(),
  oauthScope: str.nullable(),
  oauthAuthorizeParams: str.nullable(),
  oauthTokensId: id.nullable(),
  oauthConnectedAt: dateOrNull,
  oauthAuthorizationUrl: str.nullable(),
  oauthTokenUrl: str.nullable(),
  status: str,
  statusMessage: str,
  lastSyncedAt: dateOrNull,
  createdAt: date,
  updatedAt: date,
  kind: str,
  specSource: str.nullable(),
  specUrl: str.nullable(),
  readOnly: z.boolean(),
  publicOnly: z.boolean(),
  specUrlFromAssistant: z.boolean(),
  // Mail accounts (kinds jmap and imap), added in 0.2: absent from older
  // exports, which hold none.
  authUsername: str.nullable().default(null),
  mailApiUrl: str.nullable().default(null),
  mailDownloadUrl: str.nullable().default(null),
  mailAccountId: str.nullable().default(null),
  mailSubmission: z.boolean().default(false),
  smtpUrl: str.nullable().default(null),
  mailFrom: str.nullable().default(null),
})

const ServerAuthHeaderRow = z.strictObject({
  id,
  serverId: id,
  position: z.number().int(),
  headerName: str,
  valueTemplate: str,
  secretId: id.nullable(),
})

const McpToolRow = z.strictObject({
  id,
  serverId: id,
  name: str,
  title: str.nullable(),
  description: str,
  descriptionOverride: str.nullable(),
  inputSchema: str,
  annotations: str.nullable(),
  operation: str.nullable(),
  output: str.nullable(),
  createdAt: date,
  updatedAt: date,
})

const OpenApiSpecRow = z.strictObject({
  serverId: id,
  text: str,
  patches: str,
  hash: str,
  fetchedAt: date,
  builtWith: str.nullable(),
})

const SettingRow = z.strictObject({ vaultId: id, key: str, value: str })

// The browser's sign-ins, added in 0.3: absent from older files.
const BrowserProfileRow = z.strictObject({
  vaultId: id,
  ciphertext: bytes,
  sites: z.number().int().default(0),
  cookies: z.number().int().default(0),
  size: z.number().int().default(0),
  partial: z.boolean().default(false),
  savedAt: date,
})

/** The host settings that travel: the configuration, never a machine's status. */
export const EXPORTED_HOST_KEYS = [DDNS_CONFIG_KEY, TLS_CONFIG_KEY] as const

export type ExportedHostKey = (typeof EXPORTED_HOST_KEYS)[number]

export function isExportedHostKey(key: string): key is ExportedHostKey {
  return (EXPORTED_HOST_KEYS as readonly string[]).includes(key)
}

const HostSettingRow = z.strictObject({
  key: z.enum(EXPORTED_HOST_KEYS),
  value: str,
  updatedAt: date,
})

// ---- The payload ----------------------------------------------------------

export const PayloadSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  /** The PCP_VERSION that wrote it. */
  pcp: str,
  /** The last migration applied where it was written. */
  schema: str,
  exportedAt: iso,
  publicUrl: str.nullable(),
  vault: VaultRow,
  tables: z.strictObject({
    keyGrants: z.array(KeyGrantRow),
    apiTokens: z.array(ApiTokenRow),
    apiTokenServers: z.array(ApiTokenServerRow),
    apiTokenToolAccess: z.array(ApiTokenToolAccessRow),
    vaultToolAccess: z.array(VaultToolAccessRow),
    webFetchRules: z.array(WebFetchRuleRow),
    permissionRequests: z.array(PermissionRequestRow),
    memories: z.array(MemoryRow),
    secrets: z.array(SecretRow),
    servers: z.array(McpServerRow),
    serverAuthHeaders: z.array(ServerAuthHeaderRow),
    tools: z.array(McpToolRow),
    openApiSpecs: z.array(OpenApiSpecRow),
    settings: z.array(SettingRow),
    browserProfiles: z.array(BrowserProfileRow).default([]),
  }),
  host: z.array(HostSettingRow),
})

/** The payload as it is in the file: dates as strings, bytes as base64. */
export type ExportPayloadJson = z.input<typeof PayloadSchema>
/** The payload as read: rows ready to be written. */
export type ExportPayload = z.output<typeof PayloadSchema>

/** What the owner is shown before a restore replaces anything. */
export type ExportPreview = {
  exportedAt: string
  pcp: string
  vaultName: string
  publicUrl: string | null
  counts: {
    servers: number
    endpoints: number
    mailAccounts: number
    tools: number
    secrets: number
    tokens: number
    memories: number
    webFetchRules: number
    pendingRequests: number
    /** Sites the browser keeps sign-ins for; 0 without any. */
    browserSites: number
  }
  /** Null when the file carries no network settings. */
  host: { ddnsName: string | null; https: boolean } | null
}

/**
 * A database row as the file holds it: Date columns as ISO strings, Bytes
 * columns as base64, everything else as it is. (`JSON.stringify` would turn
 * a Uint8Array into an object of numbered keys.)
 */
export type RowJson<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K] extends Uint8Array
        ? string
        : T[K] extends Uint8Array | null
          ? string | null
          : T[K]
}

export function rowJson<T extends object>(row: T): RowJson<T> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Date
        ? value.toISOString()
        : value instanceof Uint8Array
          ? Buffer.from(value).toString("base64")
          : value
  }

  return out as RowJson<T>
}

const GRANT_KINDS = new Set(["password", "recovery", "api_token"])

/**
 * Whether the rows point at each other the way the tables require, before
 * any of them is written: a file put together by hand, or cut short, is
 * refused with a reason rather than a rolled-back foreign key error. Also
 * where the kinds the schema leaves as text are pinned down: a key grant is
 * one the owner may carry (never a session's).
 */
export function checkReferences(payload: ExportPayload): void {
  const { vault, tables } = payload
  const problem = (what: string) =>
    invalid(`The export is not consistent: ${what}.`)

  const idsOf = (rows: Array<{ id: string }>, what: string) => {
    const seen = new Set<string>()

    for (const row of rows) {
      if (seen.has(row.id)) {
        throw problem(`a ${what} appears twice`)
      }

      seen.add(row.id)
    }

    return seen
  }

  const tokens = idsOf(tables.apiTokens, "token")
  const secrets = idsOf(tables.secrets, "secret")
  const servers = idsOf(tables.servers, "server")
  idsOf(tables.keyGrants, "key")
  idsOf(tables.tools, "tool")
  idsOf(tables.memories, "memory")
  idsOf(tables.webFetchRules, "web fetch rule")
  idsOf(tables.permissionRequests, "request")
  idsOf(tables.serverAuthHeaders, "header")

  for (const grant of tables.keyGrants) {
    if (!GRANT_KINDS.has(grant.kind)) {
      throw problem(
        `a key of kind "${grant.kind}" does not belong in an export`,
      )
    }
  }

  if (!tables.keyGrants.some((grant) => grant.kind === "password")) {
    throw problem("it holds no password")
  }

  const ownedBy = (rows: Array<{ vaultId: string }>, what: string) => {
    for (const row of rows) {
      if (row.vaultId !== vault.id) {
        throw problem(`a ${what} belongs to another vault`)
      }
    }
  }

  ownedBy(tables.keyGrants, "key")
  ownedBy(tables.apiTokens, "token")
  ownedBy(tables.vaultToolAccess, "tool level")
  ownedBy(tables.webFetchRules, "web fetch rule")
  ownedBy(tables.permissionRequests, "request")
  ownedBy(tables.memories, "memory")
  ownedBy(tables.secrets, "secret")
  ownedBy(tables.servers, "server")
  ownedBy(tables.settings, "setting")
  ownedBy(tables.browserProfiles, "browser profile")

  if (tables.browserProfiles.length > 1) {
    throw problem("it holds more than one browser profile")
  }

  const pointsAt = (ref: string | null, known: Set<string>, what: string) => {
    if (ref !== null && !known.has(ref)) {
      throw problem(`${what} is missing`)
    }
  }

  const tokenKeys = new Set(
    tables.keyGrants
      .filter((grant) => grant.kind === "api_token")
      .map((grant) => grant.id),
  )

  for (const token of tables.apiTokens) {
    pointsAt(token.grantId, tokenKeys, "a token's key")
  }

  for (const link of tables.apiTokenServers) {
    pointsAt(link.tokenId, tokens, "a token")
    pointsAt(link.serverId, servers, "a server")
  }

  for (const level of tables.apiTokenToolAccess) {
    pointsAt(level.tokenId, tokens, "a token")
    pointsAt(level.serverId, servers, "a server")
  }

  for (const level of tables.vaultToolAccess) {
    pointsAt(level.serverId, servers, "a server")
  }

  for (const rule of tables.webFetchRules) {
    pointsAt(rule.tokenId, tokens, "a token")
  }

  for (const request of tables.permissionRequests) {
    pointsAt(request.tokenId, tokens, "a token")
    pointsAt(request.serverId, servers, "a server")
  }

  for (const memory of tables.memories) {
    pointsAt(memory.tokenId, tokens, "a token")
  }

  for (const server of tables.servers) {
    pointsAt(server.authSecretId, secrets, "a server's secret")
    pointsAt(server.oauthClientSecretId, secrets, "a server's client secret")
    pointsAt(server.oauthTokensId, secrets, "a server's OAuth tokens")
  }

  for (const header of tables.serverAuthHeaders) {
    pointsAt(header.serverId, servers, "a server")
    pointsAt(header.secretId, secrets, "a header's secret")
  }

  for (const tool of tables.tools) {
    pointsAt(tool.serverId, servers, "a server")
  }

  for (const spec of tables.openApiSpecs) {
    pointsAt(spec.serverId, servers, "a server")
  }
}

export function previewOf(payload: ExportPayload): ExportPreview {
  const { tables, host } = payload
  const ddns = host.find((row) => row.key === DDNS_CONFIG_KEY)
  const tls = host.find((row) => row.key === TLS_CONFIG_KEY)

  return {
    exportedAt: payload.exportedAt,
    pcp: payload.pcp,
    vaultName: payload.vault.name,
    publicUrl: payload.publicUrl,
    counts: {
      servers: tables.servers.filter((row) => row.kind === "mcp").length,
      endpoints: tables.servers.filter((row) => row.kind === "openapi").length,
      mailAccounts: tables.servers.filter(
        (row) => row.kind === "jmap" || row.kind === "imap",
      ).length,
      tools: tables.tools.length,
      secrets: tables.secrets.filter((row) => row.kind === "text").length,
      tokens: tables.apiTokens.filter((row) => row.revokedAt === null).length,
      memories: tables.memories.length,
      webFetchRules: tables.webFetchRules.length,
      pendingRequests: tables.permissionRequests.filter(
        (row) => row.status === "pending",
      ).length,
      browserSites: tables.browserProfiles[0]?.sites ?? 0,
    },
    host:
      ddns || tls
        ? { ddnsName: ddns ? ddnsNameOf(ddns.value) : null, https: !!tls }
        : null,
  }
}

function ddnsNameOf(value: string): string | null {
  try {
    return ddnsHostname(JSON.parse(value) as DdnsConfig)
  } catch {
    return null
  }
}

// ---- Coverage -------------------------------------------------------------

type Covers<Model, Row> = [Exclude<keyof Model, keyof Row>] extends [never]
  ? true
  : never

/**
 * Every column of each exported table has a field in its row schema. A
 * migration that adds one fails `pnpm typecheck` here until the format
 * carries it (see the top of the file for how).
 */
export const FORMAT_COVERS_SCHEMA: {
  vault: Covers<Vault, z.output<typeof VaultRow>>
  keyGrant: Covers<KeyGrant, z.output<typeof KeyGrantRow>>
  apiToken: Covers<ApiToken, z.output<typeof ApiTokenRow>>
  apiTokenServer: Covers<ApiTokenServer, z.output<typeof ApiTokenServerRow>>
  apiTokenToolAccess: Covers<
    ApiTokenToolAccess,
    z.output<typeof ApiTokenToolAccessRow>
  >
  vaultToolAccess: Covers<VaultToolAccess, z.output<typeof VaultToolAccessRow>>
  webFetchRule: Covers<WebFetchRule, z.output<typeof WebFetchRuleRow>>
  permissionRequest: Covers<
    PermissionRequest,
    z.output<typeof PermissionRequestRow>
  >
  memory: Covers<Memory, z.output<typeof MemoryRow>>
  secret: Covers<Secret, z.output<typeof SecretRow>>
  server: Covers<McpServer, z.output<typeof McpServerRow>>
  serverAuthHeader: Covers<
    ServerAuthHeader,
    z.output<typeof ServerAuthHeaderRow>
  >
  tool: Covers<McpTool, z.output<typeof McpToolRow>>
  openApiSpec: Covers<OpenApiSpec, z.output<typeof OpenApiSpecRow>>
  setting: Covers<Setting, z.output<typeof SettingRow>>
  browserProfile: Covers<BrowserProfile, z.output<typeof BrowserProfileRow>>
  hostSetting: Covers<HostSetting, z.output<typeof HostSettingRow>>
} = {
  vault: true,
  keyGrant: true,
  apiToken: true,
  apiTokenServer: true,
  apiTokenToolAccess: true,
  vaultToolAccess: true,
  webFetchRule: true,
  permissionRequest: true,
  memory: true,
  secret: true,
  server: true,
  serverAuthHeader: true,
  tool: true,
  openApiSpec: true,
  setting: true,
  browserProfile: true,
  hostSetting: true,
}
