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
import { readCallPlan } from "./openapi/plan"
import { buildRequest } from "./openapi/request"
import { validateBaseUrl, validateSpecUrl } from "./openapi/urls"
import {
  getServer,
  normalizeHeaderAuth,
  normalizeNameAndDescription,
  setServerStatus,
  slugify,
  uniqueSlug,
} from "./servers"

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
  authType: "none" | "header"
  authHeaderName?: string | null
  authValueTemplate?: string | null
  authSecretId?: string | null
}

async function normalizeEndpoint(ctx: VaultContext, input: EndpointInput) {
  const { name, description } = normalizeNameAndDescription(input)

  if (input.authType !== "none" && input.authType !== "header") {
    throw invalid(
      "An API endpoint sends a secret in a header, or no credential at all.",
    )
  }

  const auth =
    input.authType === "header"
      ? { authType: "header", ...(await normalizeHeaderAuth(ctx, input)) }
      : {
          authType: "none",
          authSecretId: null,
          authHeaderName: null,
          authValueTemplate: null,
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
  } as const
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

function generate(
  text: string,
  options: {
    readOnly: boolean
    authHeaderName: string | null
    patches: PatchOperation[]
  },
): Generated {
  const generated = generateTools(readDocument(text, options.patches), {
    readOnly: options.readOnly,
    blockedHeaders: options.authHeaderName ? [options.authHeaderName] : [],
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
  server: Pick<McpServer, "url" | "authType">,
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

  if (server.authType === "none" && generated.security) {
    notes.push(
      `The schema says requests need ${generated.security}; this endpoint sends none.`,
    )
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

async function applySpec(
  server: McpServer,
  text: string,
  patches: PatchOperation[],
  generated: Generated,
  fetchedFrom: string | null,
): Promise<SyncResult> {
  const toolCount = await storeTools(
    server.id,
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
      data: { fetchedAt, patches: edits },
    })
  } else {
    await db().openApiSpec.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, text, hash, fetchedAt, patches: edits },
      update: { text, hash, fetchedAt, patches: edits },
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
    generated,
    schemaServerUrl(generated, fetchedFrom ?? server.specUrl),
  )
  await setServerStatus(server.id, "ok", message, { lastSyncedAt: fetchedAt })

  return { status: "ok", message, toolCount }
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
    authHeaderName?: string | null
    patches?: PatchOperation[]
    /** Where the text was downloaded from, when it was. */
    fetchedFrom?: string | null
    limit?: number
  },
): EndpointPreview {
  const generated = generate(text, {
    readOnly: options.readOnly,
    authHeaderName: options.authHeaderName ?? null,
    patches: options.patches ?? [],
  })
  const baseUrl = resolveBaseUrl({
    ownerBaseUrl: options.ownerBaseUrl?.trim() || null,
    serverUrl: generated.serverUrl,
    serverUrlProblem: generated.serverUrlProblem,
    specUrl: options.fetchedFrom ?? null,
    fetchedFrom: options.fetchedFrom ?? null,
    hasSecret: options.hasSecret,
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
  const generated = generate(text, { ...data, patches })
  const baseUrl = resolveBaseUrl({
    ownerBaseUrl: data.ownerBaseUrl,
    serverUrl: generated.serverUrl,
    serverUrlProblem: generated.serverUrlProblem,
    specUrl: data.specUrl,
    fetchedFrom,
    hasSecret: data.authType === "header",
  })

  const id = newId()
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
      authSecretId: data.authSecretId,
      authHeaderName: data.authHeaderName,
      authValueTemplate: data.authValueTemplate,
    },
  })

  try {
    return {
      id,
      sync: await applySpec(server, text, patches, generated, fetchedFrom),
    }
  } catch (error) {
    // The row exists only for the tools that did not get stored: do not leave
    // an endpoint with none, and a status that says nothing.
    await db()
      .mcpServer.delete({ where: { id } })
      .catch(() => {})
    throw error
  }
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

  const attaching = data.authType === "header" && existing.authType !== "header"

  if (attaching && originOf(existing.url) !== originOf(data.specUrl)) {
    throw invalid(
      `This endpoint's address, ${existing.url}, came from the schema, not from you. To send your secret there, enter it in Base URL to confirm.`,
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
    throw new PcpError("state", "This is an MCP server, not an API endpoint.")
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
  const generated = generate(text, { ...data, patches })
  const baseUrl = baseUrlForUpdate(existing, data)
  // The owner choosing the address, or keeping the one they approved.
  const specUrlFromAssistant =
    existing.specUrlFromAssistant &&
    data.specSource === "url" &&
    data.specUrl === existing.specUrl

  const server = await db().mcpServer.update({
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
      authSecretId: data.authSecretId,
      authHeaderName: data.authHeaderName,
      authValueTemplate: data.authValueTemplate,
    },
  })

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
    throw new PcpError("state", "This is an MCP server, not an API endpoint.")
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
    const server = Object.keys(data).length
      ? await db().mcpServer.update({ where: { id }, data })
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
  const generated = generate(text, {
    readOnly,
    authHeaderName: existing.authHeaderName,
    patches,
  })
  const server = await db().mcpServer.update({
    where: { id },
    data: { ...data, readOnly },
  })

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
  { byOwner = false }: { byOwner?: boolean } = {},
): Promise<SyncResult> {
  try {
    let text: string
    let fetchedFrom: string | null = null
    const stored = await storedSpec(server.id)

    if (server.specSource === "url" && server.specUrl) {
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
    const generated = generate(text, {
      readOnly: server.readOnly,
      authHeaderName: server.authHeaderName,
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
 * One call. `authHeaders` is the endpoint's credential as a header, built
 * by upstream.ts; nothing here reads a secret. `redact` lists the values an
 * answer must not repeat back to the assistant.
 */
export async function callEndpointTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    authHeaders,
    redact,
  }: {
    authHeaders: Record<string, string>
    /** The credential's values, to keep out of what the API answers. */
    redact: string[]
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

  const request = buildRequest(plan, server.url, args, authHeaders)
  let outcome: Awaited<ReturnType<typeof executeCall>>

  try {
    outcome = await executeCall(request, {
      redact,
      publicOnly: server.publicOnly,
    })
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

  if (outcome.status === 401) {
    await setServerStatus(
      server.id,
      "auth_required",
      `${server.name} rejected the credentials PCP sent (HTTP 401).`,
    )
  }

  return outcome.result
}
