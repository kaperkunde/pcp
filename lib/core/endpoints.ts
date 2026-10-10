import { createHash } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/client"

import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "./catalogue"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, isPcpError, PcpError } from "./errors"
import { newId } from "./ids"
import { executeCall } from "./openapi/call"
import { fetchSpec } from "./openapi/fetch-spec"
import {
  generateTools,
  resolveBaseUrl,
  type Generated,
} from "./openapi/generate"
import {
  checkDocument,
  parseSpecText,
  type OpenApiDocument,
} from "./openapi/parse"
import {
  applyPatches,
  readStoredPatches,
  type PatchOperation,
} from "./openapi/patch"
import { isObject } from "./openapi/json"
import { readCallPlan, type CallPlan } from "./openapi/plan"
import { buildRequest, type UploadFile, type Uploads } from "./openapi/request"
import {
  missingResultMessage,
  parseUploadHandle,
  resolveHandles,
} from "./result-handles"
import type { ResultOpener } from "./tool-results"
import { validateBaseUrl, validateSpecUrl } from "./openapi/urls"
import { deleteManagedSecret } from "./secrets"
import {
  authHeaderNames,
  extraAuthHeadersWrite,
  getServer,
  kindNoun,
  normalizeBasicAuth,
  normalizeHeaderAuth,
  normalizeOAuthClient,
  secretColumns,
  withNewSecret,
  normalizeNameAndDescription,
  setServerStatus,
  slugify,
  uniqueSlug,
  type ExtraAuthHeader,
  type ExtraAuthHeaderInput,
} from "./servers"
import { PCP_VERSION } from "./version"

/**
 * API endpoints: HTTP APIs described by an OpenAPI schema. Each is a server
 * row of kind "openapi" whose url is the API's base URL; each operation in
 * the schema is a tool in the catalogue with a call plan beside it. The
 * gateway treats them like any other server; upstream.ts sends their calls
 * here, with the credential already turned into a header.
 *
 * The schema text is kept (openapi_spec) so an uploaded schema can be
 * regenerated — after switching read-only on, say — without the file. Beside
 * it are the endpoint's edits, a JSON Patch applied to the text every time
 * tools are generated (openapi/patch.ts): a schema read from a URL keeps its
 * fixes when it is read again, and a large schema is changed without
 * sending it whole.
 */

export type EndpointInput = {
  name: string
  description?: string
  /** The owner's base URL; empty means "the one in the schema". */
  baseUrl?: string | null
  specSource: "url" | "upload"
  specUrl?: string | null
  /** The uploaded file's text. Required to create from an upload. */
  specText?: string | null
  /**
   * With a URL: the text already downloaded from it, and the address it was
   * read from after redirects. An assistant's registration is created from
   * the document the owner approved, not from a second download.
   */
  fetched?: { text: string; url: string } | null
  /** Edits applied to the schema; left out, an edit keeps the ones it has. */
  patches?: PatchOperation[]
  /** The schema URL came from an assistant (see the column's comment). */
  specUrlFromAssistant?: boolean
  readOnly: boolean
  /** Refuse private, loopback and link-local addresses (see address.ts). */
  publicOnly?: boolean
  /** Off until the owner enables it. Default on. */
  enabled?: boolean
  authType: "none" | "header" | "basic" | "oauth"
  authHeaderName?: string | null
  authValueTemplate?: string | null
  /** A secret's id, or NEW_SECRET for one typed into the form. */
  authSecretId?: string | null
  /** With NEW_SECRET: what to call it, and its value. */
  authSecretName?: string | null
  authSecretValue?: string | null
  /** basic: the user name the secret (the password) goes with. */
  authUsername?: string | null
  /** Further headers, each with a stored secret, sent with the first. */
  authExtraHeaders?: ExtraAuthHeaderInput[] | null
  /**
   * oauth: the owner's client (without one, PCP asks for it when they
   * connect), and the scope; left empty, the scope is what the offered
   * operations need (openapi/oauth.ts).
   */
  oauthClientId?: string | null
  oauthClientSecretId?: string | null
  /** A client secret typed into the form: saved as a new secret. */
  oauthClientSecretValue?: string | null
  oauthScope?: string | null
  oauthAuthorizeParams?: string | null
}

/** The header an OAuth endpoint's token, or a login, goes in. */
const BEARER_HEADER = "Authorization"

/** Whether an endpoint sends the owner something: a secret, a login or a token. */
function sendsCredential(authType: string): boolean {
  return authType === "header" || authType === "basic" || authType === "oauth"
}

async function normalizeEndpoint(ctx: VaultContext, input: EndpointInput) {
  const { name, description } = normalizeNameAndDescription(input)

  if (!["none", "header", "basic", "oauth"].includes(input.authType)) {
    throw invalid(
      "An API endpoint sends a secret in a header, a user name and password, an OAuth token, or no credential at all.",
    )
  }

  const noClient = {
    oauthClientId: null,
    oauthClientSecretId: null,
    oauthScope: null,
    oauthAuthorizeParams: null,
  }
  const { newSecret, ...auth } =
    input.authType === "header"
      ? {
          authType: "header",
          authUsername: null,
          ...(await normalizeHeaderAuth(ctx, input, { name })),
          ...noClient,
        }
      : input.authType === "basic"
        ? {
            authType: "basic",
            // The login is the Authorization header: no operation may set it.
            authHeaderName: BEARER_HEADER,
            authValueTemplate: null,
            authExtraHeaders: [] as ExtraAuthHeader[],
            ...(await normalizeBasicAuth(ctx, input, { name })),
            ...noClient,
          }
        : input.authType === "oauth"
          ? {
              authType: "oauth",
              authSecretId: null,
              authUsername: null,
              // Blocks the header from being an operation's argument.
              authHeaderName: BEARER_HEADER,
              authValueTemplate: null,
              authExtraHeaders: [] as ExtraAuthHeader[],
              ...(await normalizeOAuthClient(ctx, input, { name })),
            }
          : {
              authType: "none",
              authSecretId: null,
              authUsername: null,
              authHeaderName: null,
              authValueTemplate: null,
              authExtraHeaders: [] as ExtraAuthHeader[],
              newSecret: null,
              ...noClient,
            }

  const specSource = input.specSource === "upload" ? "upload" : "url"

  return {
    name,
    description,
    ...auth,
    specSource,
    specUrl: specSource === "url" ? validateSpecUrl(input.specUrl ?? "") : null,
    readOnly: input.readOnly,
    publicOnly: input.publicOnly === true,
    ownerBaseUrl: input.baseUrl?.trim() || null,
    newSecret,
  } as const
}

/** The headers a normalized credential goes in, first to last. */
function sentHeaders(auth: {
  authHeaderName: string | null
  authExtraHeaders: ExtraAuthHeader[]
}): string[] {
  return auth.authHeaderName
    ? [
        auth.authHeaderName,
        ...auth.authExtraHeaders.map((extra) => extra.headerName),
      ]
    : []
}

/**
 * Where an OAuth endpoint signs in, read from the schema it is being saved
 * with, and the scope: the one given, else what the offered operations need.
 * Every column null for an endpoint that does not use OAuth.
 */
function oauthColumns(
  data: { authType: string; oauthScope: string | null },
  generated: Generated,
): {
  oauthAuthorizationUrl: string | null
  oauthTokenUrl: string | null
  oauthScope: string | null
} {
  if (data.authType !== "oauth") {
    return {
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthScope: null,
    }
  }

  const { flow, problem } = generated.oauth

  if (!flow) {
    throw invalid(
      problem ??
        "The schema declares no OAuth sign-in (an oauth2 security scheme with an authorizationCode flow). Add one with an edit, or send a secret in a header.",
    )
  }

  return {
    oauthAuthorizationUrl: flow.authorizationUrl,
    oauthTokenUrl: flow.tokenUrl,
    oauthScope: data.oauthScope ?? (flow.scopes.join(" ") || null),
  }
}

/** The schema text with the edits applied, checked again as a schema. */
export function readDocument(
  text: string,
  patches: PatchOperation[],
): OpenApiDocument {
  const parsed = parseSpecText(text)
  return patches.length > 0
    ? checkDocument(applyPatches(parsed, patches))
    : parsed
}

/** The tools a schema with these edits gives, or what makes it unusable. */
export function generateEndpointTools(
  text: string,
  options: {
    readOnly: boolean
    /** Where the credential goes: never a header an argument sets. */
    authHeaderNames: string[]
    patches: PatchOperation[]
  },
): Generated {
  const generated = generateTools(readDocument(text, options.patches), {
    readOnly: options.readOnly,
    blockedHeaders: options.authHeaderNames,
  })

  if (generated.tools.length === 0) {
    const skipped = generated.skipped.length
    throw invalid(
      skipped > 0
        ? `None of the schema's operations can be offered: ${skippedList(generated)}.`
        : options.readOnly
          ? "The schema has no GET operations to offer read-only."
          : "The schema has no operations.",
    )
  }

  return generated
}

function skippedList(generated: Generated, max = 3): string {
  const shown = generated.skipped
    .slice(0, max)
    .map(({ operation, reason }) => `${operation} (${reason})`)
  const more = generated.skipped.length - shown.length

  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`
}

function fallbackDescription(generated: Generated): string {
  return (generated.description || generated.title).slice(0, 1000)
}

/**
 * What the owner should know after a read: operations PCP left out, a
 * schema whose server moved, credentials the schema asks for that the
 * endpoint does not send. Empty when there is nothing to say.
 */
function statusNotes(
  server: Pick<
    McpServer,
    "url" | "authType" | "oauthAuthorizationUrl" | "oauthTokenUrl"
  >,
  sent: string[],
  generated: Generated,
  schemaServer: string | null,
): string {
  const notes: string[] = []

  if (generated.skipped.length > 0) {
    notes.push(
      `Skipped ${generated.skipped.length}: ${skippedList(generated)}.`,
    )
  }

  if (schemaServer && schemaServer !== server.url) {
    notes.push(
      `The schema names ${schemaServer} as its server; PCP sends requests to ${server.url}.`,
    )
  }

  const flow = generated.oauth.flow

  if (
    server.authType === "oauth" &&
    flow &&
    (flow.authorizationUrl !== server.oauthAuthorizationUrl ||
      flow.tokenUrl !== server.oauthTokenUrl)
  ) {
    notes.push(
      "The schema's OAuth addresses have changed; PCP still signs in where you approved. Save the endpoint's settings to take the new ones.",
    )
  }

  if (server.authType === "none" && generated.security) {
    notes.push(
      `The schema says requests need ${generated.security}; this endpoint sends none.`,
    )
  } else if (server.authType === "header" || server.authType === "basic") {
    const lower = new Set(sent.map((name) => name.toLowerCase()))
    const missing = generated.securityHeaders.filter(
      (name) => !lower.has(name.toLowerCase()),
    )

    if (missing.length > 0) {
      notes.push(
        `The schema says requests also need a key in ${missing.join(" and ")}; this endpoint does not send ${missing.length === 1 ? "that header" : "those headers"}.`,
      )
    }
  }

  return notes.join(" ")
}

/** The schema's own server as an absolute URL, when it has one. */
function schemaServerUrl(
  generated: Generated,
  against: string | null,
): string | null {
  try {
    return resolveBaseUrl({
      ownerBaseUrl: null,
      serverUrl: generated.serverUrl,
      serverUrlProblem: generated.serverUrlProblem,
      specUrl: null,
      fetchedFrom: against,
      hasSecret: false,
    })
  } catch {
    return null
  }
}

function storeGenerated(serverId: string, generated: Generated) {
  return storeTools(
    serverId,
    generated.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      operation: JSON.stringify(tool.operation),
      output: tool.output,
    })),
  )
}

async function applySpec(
  server: McpServer,
  text: string,
  patches: PatchOperation[],
  generated: Generated,
  fetchedFrom: string | null,
): Promise<SyncResult> {
  const toolCount = await storeGenerated(server.id, generated)

  const hash = specHash(text)
  const stored = await db().openApiSpec.findUnique({
    where: { serverId: server.id },
    select: { hash: true },
  })
  const fetchedAt = new Date()
  const edits = JSON.stringify(patches)

  if (stored?.hash === hash) {
    await db().openApiSpec.update({
      where: { serverId: server.id },
      data: { fetchedAt, patches: edits, builtWith: PCP_VERSION },
    })
  } else {
    const columns = { text, hash, fetchedAt, patches: edits }
    await db().openApiSpec.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, ...columns, builtWith: PCP_VERSION },
      update: { ...columns, builtWith: PCP_VERSION },
    })
  }

  if (!server.description) {
    const description = fallbackDescription(generated)
    if (description) {
      await db().mcpServer.update({
        where: { id: server.id },
        data: { description },
      })
    }
  }

  const message = statusNotes(
    server,
    await authHeaderNames(server),
    generated,
    schemaServerUrl(generated, fetchedFrom ?? server.specUrl),
  )
  await setServerStatus(server.id, "ok", message, { lastSyncedAt: fetchedAt })

  return { status: "ok", message, toolCount }
}

/**
 * Rebuilds the tools of every endpoint another PCP version built, from the
 * copy and edits PCP keeps: the schema the owner approved, read by today's
 * generator. Run at boot. Without it an endpoint keeps what the PCP that
 * added it made of its schema (no outline of its answers, a header PCP now
 * sends itself still asked for) until its schema is read again, which for
 * an uploaded schema, or a URL whose document has since changed, is never.
 *
 * Nothing is downloaded and nothing about the endpoint changes but its
 * tools: not when it was read, not its status or what that says (that the
 * document at its URL changed, say, or that it waits to be signed in to).
 * An endpoint whose schema no longer builds keeps the tools it has and is
 * tried again at the next boot.
 */
export async function rebuildOutdatedEndpoints(): Promise<{
  rebuilt: number
  failed: Array<{ serverId: string; message: string }>
}> {
  const outdated = await db().openApiSpec.findMany({
    where: { OR: [{ builtWith: null }, { builtWith: { not: PCP_VERSION } }] },
    select: { serverId: true },
  })
  const failed: Array<{ serverId: string; message: string }> = []
  let rebuilt = 0

  // One at a time: each holds a whole schema in memory.
  for (const { serverId } of outdated) {
    try {
      const server = await db().mcpServer.findUnique({
        where: { id: serverId },
      })
      const spec = await storedSpec(serverId)

      if (!server || server.kind !== "openapi" || !spec) {
        continue
      }

      const generated = generateEndpointTools(spec.text, {
        readOnly: server.readOnly,
        authHeaderNames: await authHeaderNames(server),
        patches: spec.patches,
      })

      await storeGenerated(serverId, generated)
      await db().openApiSpec.update({
        where: { serverId },
        data: { builtWith: PCP_VERSION },
      })
      rebuilt += 1
    } catch (error) {
      failed.push({
        serverId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { rebuilt, failed }
}

/** The fingerprint kept with a schema's text, to tell a changed one. */
export function specHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** What PCP keeps of an endpoint's schema: the text and its edits. */
export async function storedSpec(serverId: string): Promise<{
  text: string
  hash: string
  patches: PatchOperation[]
} | null> {
  const stored = await db().openApiSpec.findUnique({
    where: { serverId },
    select: { text: true, hash: true, patches: true },
  })

  return stored
    ? { ...stored, patches: readStoredPatches(stored.patches) }
    : null
}

export type EndpointPreview = {
  /** Where requests would go. */
  baseUrl: string
  toolCount: number
  /** Operations as "GET /pets", in document order, as many as `limit`. */
  operations: string[]
  /** How many operations the list leaves out. */
  more: number
  /** "GET 4, POST 2": what the tools would do. */
  methods: string
  /** What PCP leaves out, in words; empty when nothing. */
  skipped: string
  /** With OAuth: where the owner signs in, where the token comes from. */
  oauth: {
    authorizationUrl: string
    tokenUrl: string
    /** The scope that will be asked for. */
    scope: string | null
  } | null
}

/**
 * What creating an endpoint from this text would give, worked out without a
 * row, a request or a secret. It throws what createEndpoint would throw, so
 * a schema that cannot be used is refused before anyone is asked about it.
 */
export function previewEndpoint(
  text: string,
  options: {
    readOnly: boolean
    ownerBaseUrl?: string | null
    hasSecret: boolean
    /** The headers the credential goes in. */
    authHeaderNames?: string[]
    /** Signs in with the schema's OAuth flow; the scope, if one was given. */
    oauth?: { scope: string | null }
    patches?: PatchOperation[]
    /** Where the text was downloaded from, when it was. */
    fetchedFrom?: string | null
    limit?: number
  },
): EndpointPreview {
  const generated = generateEndpointTools(text, {
    readOnly: options.readOnly,
    authHeaderNames: options.oauth
      ? [BEARER_HEADER]
      : (options.authHeaderNames ?? []),
    patches: options.patches ?? [],
  })
  const oauth = options.oauth
    ? oauthColumns(
        { authType: "oauth", oauthScope: options.oauth.scope },
        generated,
      )
    : null
  const baseUrl = resolveBaseUrl({
    ownerBaseUrl: options.ownerBaseUrl?.trim() || null,
    serverUrl: generated.serverUrl,
    serverUrlProblem: generated.serverUrlProblem,
    specUrl: options.fetchedFrom ?? null,
    fetchedFrom: options.fetchedFrom ?? null,
    hasSecret: options.hasSecret || oauth !== null,
  })
  const limit = options.limit ?? 12
  const counts = new Map<string, number>()

  for (const tool of generated.tools) {
    const method = tool.operation.method
    counts.set(method, (counts.get(method) ?? 0) + 1)
  }

  return {
    baseUrl,
    toolCount: generated.tools.length,
    operations: generated.tools
      .slice(0, limit)
      .map((tool) =>
        `${tool.operation.method} ${tool.operation.path}`.slice(0, 120),
      ),
    more: Math.max(0, generated.tools.length - limit),
    methods: [...counts]
      .map(([method, count]) => `${method} ${count}`)
      .join(", "),
    skipped: generated.skipped.length > 0 ? skippedList(generated) : "",
    oauth: oauth && {
      authorizationUrl: oauth.oauthAuthorizationUrl!,
      tokenUrl: oauth.oauthTokenUrl!,
      scope: oauth.oauthScope,
    },
  }
}

export async function createEndpoint(
  ctx: VaultContext,
  input: EndpointInput,
): Promise<{ id: string; sync: SyncResult }> {
  const data = await normalizeEndpoint(ctx, input)
  let text: string
  let fetchedFrom: string | null = null

  if (data.specSource === "upload") {
    if (!input.specText?.trim()) {
      throw invalid("Choose the schema file to upload.")
    }
    text = input.specText
  } else if (input.fetched) {
    ;({ text, url: fetchedFrom } = input.fetched)
  } else {
    ;({ text, url: fetchedFrom } = await fetchSpec(data.specUrl!, {
      publicOnly: data.publicOnly,
    }))
  }

  // Everything that can be wrong with the schema is found before a row
  // exists, so a bad one leaves nothing behind.
  const patches = input.patches ?? []
  const generated = generateEndpointTools(text, {
    readOnly: data.readOnly,
    authHeaderNames: sentHeaders(data),
    patches,
  })
  const baseUrl = resolveBaseUrl({
    ownerBaseUrl: data.ownerBaseUrl,
    serverUrl: generated.serverUrl,
    serverUrlProblem: generated.serverUrlProblem,
    specUrl: data.specUrl,
    fetchedFrom,
    hasSecret: sendsCredential(data.authType),
  })
  const oauth = oauthColumns(data, generated)

  const id = newId()

  return withNewSecret(ctx, data.newSecret, async (secretId) => {
    const server = await db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        kind: "openapi",
        enabled: input.enabled !== false,
        slug: await uniqueSlug(ctx.vaultId, slugify(data.name)),
        name: data.name,
        description: data.description,
        url: baseUrl,
        specSource: data.specSource,
        specUrl: data.specUrl,
        readOnly: data.readOnly,
        publicOnly: data.publicOnly,
        specUrlFromAssistant:
          data.specSource === "url" && input.specUrlFromAssistant === true,
        authType: data.authType,
        authUsername: data.authUsername,
        authHeaderName: data.authHeaderName,
        authValueTemplate: data.authValueTemplate,
        ...secretColumns(data, secretId),
        authHeaders: extraAuthHeadersWrite(data.authExtraHeaders, {
          replace: false,
        }),
        oauthClientId: data.oauthClientId,
        oauthAuthorizeParams: data.oauthAuthorizeParams,
        ...oauth,
      },
    })

    try {
      return {
        id,
        sync: await applySpec(server, text, patches, generated, fetchedFrom),
      }
    } catch (error) {
      // The row exists only for the tools that did not get stored: do not
      // leave an endpoint with none, and a status that says nothing.
      await db()
        .mcpServer.delete({ where: { id } })
        .catch(() => {})
      throw error
    }
  })
}

function originOf(address: string | null): string | null {
  try {
    return address ? new URL(address).origin : null
  } catch {
    return null
  }
}

/**
 * Where an edited endpoint's requests go. An address the owner typed is
 * used. Otherwise it stays where it is: an edit never re-reads the schema's
 * server. And a secret is only ever attached to an address the owner has
 * confirmed, either by typing it now, by having sent a secret there before,
 * or because it is on the origin of the schema they gave: the address
 * otherwise came from someone else's document, and saving the form would
 * send the secret wherever that document says.
 */
function baseUrlForUpdate(
  existing: McpServer,
  data: {
    ownerBaseUrl: string | null
    authType: string
    specUrl: string | null
  },
): string {
  if (data.ownerBaseUrl) {
    return validateBaseUrl(data.ownerBaseUrl)
  }

  const attaching =
    sendsCredential(data.authType) && !sendsCredential(existing.authType)

  if (attaching && originOf(existing.url) !== originOf(data.specUrl)) {
    throw invalid(
      `This endpoint's address, ${existing.url}, came from the schema, not from you. To send your ${data.authType === "oauth" ? "token" : "secret"} there, enter it in Base URL to confirm.`,
    )
  }

  return existing.url
}

export async function updateEndpoint(
  ctx: VaultContext,
  id: string,
  input: EndpointInput,
): Promise<{ sync: SyncResult }> {
  const existing = await getServer(ctx, id)

  if (existing.kind !== "openapi") {
    throw new PcpError(
      "state",
      `This is ${kindNoun(existing.kind)}, not an API endpoint.`,
    )
  }

  const data = await normalizeEndpoint(ctx, input)
  const stored = await storedSpec(id)

  let text: string
  let fetchedFrom: string | null = null

  if (data.specSource === "upload") {
    if (input.specText?.trim()) {
      text = input.specText
    } else if (stored && existing.specSource === "upload") {
      text = stored.text
    } else {
      throw invalid("Choose the schema file to upload.")
    }
  } else if (
    stored &&
    existing.specSource === "url" &&
    existing.specUrl === data.specUrl
  ) {
    // Same address: regenerate from the copy PCP has. "Re-read schema"
    // downloads it again.
    text = stored.text
  } else {
    ;({ text, url: fetchedFrom } = await fetchSpec(data.specUrl!, {
      publicOnly: data.publicOnly,
    }))
  }

  const patches = input.patches ?? stored?.patches ?? []
  const generated = generateEndpointTools(text, {
    readOnly: data.readOnly,
    authHeaderNames: sentHeaders(data),
    patches,
  })
  const baseUrl = baseUrlForUpdate(existing, data)
  // The owner choosing the address, or keeping the one they approved.
  const specUrlFromAssistant =
    existing.specUrlFromAssistant &&
    data.specSource === "url" &&
    data.specUrl === existing.specUrl

  const oauth = oauthColumns(data, generated)
  // Tokens belong to the sign-in they came from: another client, sign-in or
  // token address, or API address, and they go.
  const dropTokens =
    existing.oauthTokensId !== null &&
    (data.authType !== "oauth" ||
      data.oauthClientId !== existing.oauthClientId ||
      oauth.oauthAuthorizationUrl !== existing.oauthAuthorizationUrl ||
      oauth.oauthTokenUrl !== existing.oauthTokenUrl ||
      baseUrl !== existing.url)

  const server = await withNewSecret(ctx, data.newSecret, (secretId) =>
    db().mcpServer.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        url: baseUrl,
        specSource: data.specSource,
        specUrl: data.specUrl,
        readOnly: data.readOnly,
        publicOnly: data.publicOnly,
        specUrlFromAssistant,
        authType: data.authType,
        authUsername: data.authUsername,
        authHeaderName: data.authHeaderName,
        authValueTemplate: data.authValueTemplate,
        ...secretColumns(data, secretId),
        authHeaders: extraAuthHeadersWrite(data.authExtraHeaders, {
          replace: true,
        }),
        oauthClientId: data.oauthClientId,
        oauthAuthorizeParams: data.oauthAuthorizeParams,
        ...oauth,
        ...(dropTokens ? { oauthTokensId: null, oauthConnectedAt: null } : {}),
      },
    }),
  )

  if (dropTokens && existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }

  return {
    sync: await applySpec(server, text, patches, generated, fetchedFrom),
  }
}

export type EndpointChanges = {
  name?: string
  description?: string
  baseUrl?: string
  readOnly?: boolean
  /** A whole new schema, as text. Only for an endpoint added as text. */
  specText?: string
  /**
   * A new download of the schema's URL (downloadSpec). Only for an endpoint
   * that reads its schema from one.
   */
  fetched?: { text: string; url: string }
  /** The endpoint's edits, all of them: they replace the ones it has. */
  patches?: PatchOperation[]
  /**
   * Turns the endpoint off in the first write the change makes, so a change
   * that stops halfway is never live, and one refused before anything is
   * written (an edit that does not apply) leaves it as it was.
   */
  disable?: boolean
  /**
   * The endpoint as the caller read it to decide on the change. It is
   * written only while these still say the same, so a change decided on an
   * older read (an assistant's, waiting on a download) is refused rather
   * than made to an endpoint the owner has since taken over or enabled.
   */
  unchanged?: Pick<
    McpServer,
    "url" | "enabled" | "authType" | "publicOnly" | "specUrl"
  >
}

/** Writes a change's columns, only to the endpoint as `unchanged` says. */
async function writeChange(
  id: string,
  data: Record<string, unknown>,
  unchanged: EndpointChanges["unchanged"],
): Promise<McpServer> {
  if (!unchanged) {
    return db().mcpServer.update({ where: { id }, data })
  }

  const where = { id, ...unchanged }
  const { count } = Object.keys(data).length
    ? await db().mcpServer.updateMany({ where, data })
    : { count: await db().mcpServer.count({ where }) }

  if (count === 0) {
    throw new PcpError(
      "state",
      "The endpoint changed while this change was being made, so nothing changed. Read it again with get_endpoint and try again.",
    )
  }

  return db().mcpServer.findUniqueOrThrow({ where: { id } })
}

/**
 * A change an assistant asked for. It writes only the columns it names and
 * never the credential, the schema's source or what public-only says, so the
 * rules about those cannot be got around by what is passed in, and an owner
 * changing them at the same moment is not overwritten. A schema or an edit
 * that does not apply leaves everything as it was: tools are generated before
 * anything is written.
 */
export async function changeEndpoint(
  ctx: VaultContext,
  id: string,
  changes: EndpointChanges,
): Promise<{ sync: SyncResult }> {
  const existing = await getServer(ctx, id)

  if (existing.kind !== "openapi") {
    throw new PcpError(
      "state",
      `This is ${kindNoun(existing.kind)}, not an API endpoint.`,
    )
  }

  if (changes.specText !== undefined && existing.specSource !== "upload") {
    throw new PcpError(
      "forbidden",
      "This endpoint reads its schema from a URL: change it with edits, or read the URL again.",
    )
  }

  if (changes.fetched !== undefined && existing.specSource !== "url") {
    throw new PcpError(
      "forbidden",
      "This endpoint's schema was given as text; there is no URL to read again.",
    )
  }

  const data: {
    name?: string
    description?: string
    url?: string
    readOnly?: boolean
    enabled?: false
  } = changes.disable ? { enabled: false } : {}

  if (changes.name !== undefined || changes.description !== undefined) {
    const text = normalizeNameAndDescription({
      name: changes.name ?? existing.name,
      description: changes.description ?? existing.description,
    })

    if (changes.name !== undefined) data.name = text.name
    if (changes.description !== undefined) data.description = text.description
  }

  if (changes.baseUrl !== undefined) {
    data.url = validateBaseUrl(changes.baseUrl)
  }

  const readOnly = changes.readOnly ?? existing.readOnly
  const regenerate =
    changes.specText !== undefined ||
    changes.fetched !== undefined ||
    changes.patches !== undefined ||
    readOnly !== existing.readOnly

  if (!regenerate) {
    const server =
      Object.keys(data).length || changes.unchanged
        ? await writeChange(id, data, changes.unchanged)
        : existing

    return {
      sync: {
        status: server.status === "ok" ? "ok" : "error",
        message: server.statusMessage,
        toolCount: existing.tools.length,
      },
    }
  }

  const stored = await storedSpec(id)
  const text = changes.specText ?? changes.fetched?.text ?? stored?.text

  if (text === undefined) {
    throw invalid("PCP has no copy of this schema to rebuild the tools from.")
  }

  const patches = changes.patches ?? stored?.patches ?? []
  const generated = generateEndpointTools(text, {
    readOnly,
    authHeaderNames: await authHeaderNames(existing),
    patches,
  })
  const server = await writeChange(id, { ...data, readOnly }, changes.unchanged)

  return {
    sync: await applySpec(
      server,
      text,
      patches,
      generated,
      changes.fetched?.url ?? null,
    ),
  }
}

/** Downloads an endpoint's schema URL again, under the endpoint's rules. */
export async function downloadSpec(
  server: Pick<McpServer, "specUrl" | "publicOnly">,
): Promise<{ text: string; url: string }> {
  if (!server.specUrl) {
    throw invalid("This endpoint has no schema URL.")
  }

  return fetchSpec(server.specUrl, { publicOnly: server.publicOnly })
}

/**
 * Re-reads the schema: downloaded again when it came from a URL, the kept
 * copy when it was uploaded, with the endpoint's edits applied either way.
 * The base URL is never changed here — a schema that moved its server is
 * reported, not followed — and a schema that no longer reads, or that an
 * edit no longer applies to, leaves the existing tools in place.
 *
 * A URL an assistant proposed is held to the document the owner approved:
 * unless the owner asked for this read, a changed document is reported and
 * not taken, so whoever controls that address cannot add operations, or
 * words every assistant reads, by changing the file.
 */
export async function syncEndpointTools(
  server: McpServer,
  {
    byOwner = false,
    fromCopy = false,
  }: {
    byOwner?: boolean
    /** Rebuild from the copy PCP holds, without downloading the schema. */
    fromCopy?: boolean
  } = {},
): Promise<SyncResult> {
  try {
    let text: string
    let fetchedFrom: string | null = null
    const stored = await storedSpec(server.id)

    if (
      server.specSource === "url" &&
      server.specUrl &&
      !(fromCopy && stored)
    ) {
      ;({ text, url: fetchedFrom } = await downloadSpec(server))

      if (
        server.specUrlFromAssistant &&
        !byOwner &&
        stored &&
        specHash(text) !== stored.hash
      ) {
        const message =
          "The schema at its URL has changed since it was approved. The tools are still built from the approved copy; re-read it in PCP to take the new one."
        await setServerStatus(server.id, "ok", message, {
          lastSyncedAt: new Date(),
        })

        return {
          status: "ok",
          message,
          toolCount: await db().mcpTool.count({
            where: { serverId: server.id },
          }),
        }
      }
    } else {
      if (!stored) {
        throw invalid("PCP has no copy of this schema. Upload it again.")
      }
      text = stored.text
    }

    const patches = stored?.patches ?? []
    const generated = generateEndpointTools(text, {
      readOnly: server.readOnly,
      authHeaderNames: await authHeaderNames(server),
      patches,
    })

    return await applySpec(server, text, patches, generated, fetchedFrom)
  } catch (error) {
    const message = (
      isPcpError(error)
        ? error.message
        : `The schema could not be read: ${error instanceof Error ? error.message : String(error)}`
    ).slice(0, 500)
    await setServerStatus(server.id, "error", message)

    return { status: "error", message, toolCount: 0 }
  }
}

/**
 * One call. `authHeaders` is the endpoint's credential as headers, built
 * by upstream.ts; nothing here reads a secret. `redact` lists the values an
 * answer must not repeat back to the assistant.
 */
/**
 * An upload's files, opened from the token's kept results, and the
 * arguments with every other handle resolved. A file field takes only a
 * handle; an unknown id is refused by name before anything is sent.
 */
async function openUploads(
  plan: CallPlan,
  args: Record<string, unknown>,
  open: ResultOpener | undefined,
): Promise<{ args: Record<string, unknown>; uploads: Uploads }> {
  const body = plan.body

  if (!body || (body.encoding !== "binary" && body.encoding !== "multipart")) {
    return { args: open ? await resolveHandles(args, open) : args, uploads: {} }
  }

  const readFile = async (
    value: unknown,
    field: string,
  ): Promise<UploadFile> => {
    const handle = parseUploadHandle(value)

    if (!handle) {
      throw invalid(
        `"${field}" is a file: pass a result PCP kept for you, as {"$result": "<id>"}.`,
      )
    }

    if (!open) {
      throw invalid(`"${field}" is a file PCP cannot read for this call.`)
    }

    const opened = await open(handle.$result)

    if (!opened) {
      throw invalid(missingResultMessage())
    }

    return {
      bytes: opened.bytes(),
      name: handle.name ?? opened.name,
      type: handle.type ?? opened.mediaType,
    }
  }

  const value = args[body.arg]
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== body.arg),
  )
  const resolved = open ? await resolveHandles(rest, open) : rest

  if (value === undefined || value === null) {
    return { args: resolved, uploads: {} }
  }

  if (body.encoding === "binary") {
    return {
      args: { ...resolved, [body.arg]: value },
      uploads: { body: await readFile(value, body.arg) },
    }
  }

  if (!isObject(value)) {
    throw invalid(`"${body.arg}" must be an object of form fields.`)
  }

  const fields: Record<string, UploadFile[]> = {}
  const others: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value)) {
    const file = body.files?.find((entry) => entry.name === key)

    if (!file) {
      others[key] = item
      continue
    }

    if (item === undefined || item === null) {
      continue
    }

    const items = file.many && Array.isArray(item) ? item : [item]
    fields[key] = []

    for (const entry of items) {
      fields[key].push(await readFile(entry, `${body.arg}.${key}`))
    }
  }

  const resolvedOthers = open ? await resolveHandles(others, open) : others

  return {
    args: { ...resolved, [body.arg]: { ...value, ...resolvedOthers } },
    uploads: { fields },
  }
}

export async function callEndpointTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    authHeaders,
    redact,
    renew,
    open,
  }: {
    authHeaders: Record<string, string>
    /**
     * Opens a result the token kept: handles in the arguments, and the
     * files of an upload.
     */
    open?: ResultOpener
    /** The credential's values, to keep out of what the API answers. */
    redact: string[]
    /**
     * A renewed credential, for one more try after a 401 (an OAuth token
     * the API no longer takes). Built by upstream.ts, like the first.
     */
    renew?: () => Promise<{ headers: Record<string, string>; redact: string[] }>
  },
): Promise<CallToolResult> {
  const tool = await db().mcpTool.findUnique({
    where: { serverId_name: { serverId: server.id, name: toolName } },
    select: { operation: true },
  })
  const plan = readCallPlan(tool?.operation ?? null)

  if (!plan) {
    throw new PcpError(
      "state",
      `${server.name} has no usable tool called ${toolName}. Re-read its schema in PCP.`,
    )
  }

  if (server.readOnly && plan.method !== "GET") {
    throw new PcpError(
      "forbidden",
      `${server.name} is read-only in PCP; ${toolName} would change data.`,
    )
  }

  // Before anything is sent: an unknown id or a bad file argument sends
  // nothing.
  const prepared = await openUploads(plan, args, open)

  const attempt = async (
    headers: Record<string, string>,
    secrets: string[],
  ): Promise<Awaited<ReturnType<typeof executeCall>>> => {
    try {
      return await executeCall(
        buildRequest(
          plan,
          server.url,
          prepared.args,
          headers,
          prepared.uploads,
        ),
        {
          redact: secrets,
          publicOnly: server.publicOnly,
        },
      )
    } catch (error) {
      // The endpoint refusing an address is its rule working, not an outage:
      // say so, and leave its status alone.
      if (isPcpError(error) && error.code === "forbidden") {
        throw error
      }

      const message =
        `${server.name} could not be reached: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          500,
        )
      await setServerStatus(server.id, "error", message)
      throw new PcpError("upstream", message)
    }
  }

  let outcome = await attempt(authHeaders, redact)

  // Outside the attempt: a renewal that cannot happen means "connect it
  // again", not "could not be reached".
  if (outcome.status === 401 && renew) {
    const renewed = await renew()
    outcome = await attempt(renewed.headers, [...redact, ...renewed.redact])
  }

  if (outcome.status === 401) {
    await setServerStatus(
      server.id,
      "auth_required",
      `${server.name} rejected the credentials PCP sent (HTTP 401).`,
    )
  }

  return outcome.result
}
