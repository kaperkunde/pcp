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
import { parseSpecText } from "./openapi/parse"
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
 * regenerated — after switching read-only on, say — without the file.
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
  readOnly: boolean
  /** Refuse private, loopback and link-local addresses (see address.ts). */
  publicOnly?: boolean
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

function generate(
  text: string,
  options: { readOnly: boolean; authHeaderName: string | null },
): Generated {
  const generated = generateTools(parseSpecText(text), {
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
    })),
  )

  const hash = createHash("sha256").update(text).digest("hex")
  const stored = await db().openApiSpec.findUnique({
    where: { serverId: server.id },
    select: { hash: true },
  })
  const fetchedAt = new Date()

  if (stored?.hash === hash) {
    await db().openApiSpec.update({
      where: { serverId: server.id },
      data: { fetchedAt },
    })
  } else {
    await db().openApiSpec.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, text, hash, fetchedAt },
      update: { text, hash, fetchedAt },
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
  } else {
    ;({ text, url: fetchedFrom } = await fetchSpec(data.specUrl!, {
      publicOnly: data.publicOnly,
    }))
  }

  // Everything that can be wrong with the schema is found before a row
  // exists, so a bad one leaves nothing behind.
  const generated = generate(text, data)
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
      slug: await uniqueSlug(ctx.vaultId, slugify(data.name)),
      name: data.name,
      description: data.description,
      url: baseUrl,
      specSource: data.specSource,
      specUrl: data.specUrl,
      readOnly: data.readOnly,
      publicOnly: data.publicOnly,
      authType: data.authType,
      authSecretId: data.authSecretId,
      authHeaderName: data.authHeaderName,
      authValueTemplate: data.authValueTemplate,
    },
  })

  try {
    return { id, sync: await applySpec(server, text, generated, fetchedFrom) }
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
  const stored = await db().openApiSpec.findUnique({
    where: { serverId: id },
    select: { text: true },
  })

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

  const generated = generate(text, data)
  const baseUrl = baseUrlForUpdate(existing, data)

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
      authType: data.authType,
      authSecretId: data.authSecretId,
      authHeaderName: data.authHeaderName,
      authValueTemplate: data.authValueTemplate,
    },
  })

  return { sync: await applySpec(server, text, generated, fetchedFrom) }
}

/**
 * Re-reads the schema: downloaded again when it came from a URL, the kept
 * copy when it was uploaded. The base URL is never changed here — a schema
 * that moved its server is reported, not followed — and a schema that no
 * longer reads leaves the existing tools in place.
 */
export async function syncEndpointTools(
  server: McpServer,
): Promise<SyncResult> {
  try {
    let text: string
    let fetchedFrom: string | null = null

    if (server.specSource === "url" && server.specUrl) {
      ;({ text, url: fetchedFrom } = await fetchSpec(server.specUrl, {
        publicOnly: server.publicOnly,
      }))
    } else {
      const stored = await db().openApiSpec.findUnique({
        where: { serverId: server.id },
        select: { text: true },
      })
      if (!stored) {
        throw invalid("PCP has no copy of this schema. Upload it again.")
      }
      text = stored.text
    }

    const generated = generate(text, {
      readOnly: server.readOnly,
      authHeaderName: server.authHeaderName,
    })

    return await applySpec(server, text, generated, fetchedFrom)
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
