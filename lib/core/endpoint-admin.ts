import dns from "node:dns"

import type { McpServer, McpTool } from "@/lib/generated/prisma/client"

import type { ResolvedToken } from "./api-tokens"
import { db } from "./db"
import { createEndpoint, updateEndpoint, type EndpointInput } from "./endpoints"
import { invalid, PcpError } from "./errors"
import { bareHostname, isPublicAddress } from "./openapi/address"
import { readCallPlan } from "./openapi/plan"
import { validateBaseUrl } from "./openapi/urls"
import { setToolDescription, type ServerStatus } from "./servers"

/**
 * Registering and changing API endpoints on behalf of an assistant, through
 * the gateway's register_endpoint, update_endpoint and get_endpoint tools.
 *
 * An assistant is not the owner. It decides what goes into a tool call, and
 * a prompt injected into it could decide worse. So what it may do here is
 * narrower than what the owner can do in the UI, and the line is drawn at
 * where PCP sends requests and what it sends them with:
 *
 * - It can never choose, see or attach a secret, or change a header's name
 *   or template. An endpoint it registers has no credential; the owner adds
 *   one in the UI.
 * - It cannot move an endpoint that sends a secret: with a secret attached,
 *   the base URL is the owner's. Otherwise a registered schema or a new
 *   base URL would be a way to send the owner's key to a server of the
 *   assistant's choosing.
 * - What it registers refuses private, loopback and link-local addresses
 *   (publicOnly), checked when the socket connects, so it cannot use PCP to
 *   reach the owner's network. Only the owner can clear that.
 * - It can switch read-only on, but not off while a secret is attached.
 * - It only supplies a schema as text. PCP never fetches an address it
 *   chose.
 */

const MAX_INCLUDED_SPEC = 50_000
const ADDRESS_LOOKUP_TIMEOUT_MS = 3000

export type EndpointScope = Pick<ResolvedToken, "ctx" | "tokenId" | "serverIds">

export type EndpointDetails = {
  endpoint: string
  name: string
  description: string
  baseUrl: string
  readOnly: boolean
  /** Refuses private, local and link-local addresses; only the owner clears it. */
  publicOnly: boolean
  enabled: boolean
  schema: {
    source: "url" | "upload"
    url: string | null
    readAt: string | null
  }
  authentication: { type: "none" | "header"; header: string | null }
  status: ServerStatus
  statusMessage: string
  /** What this token can and cannot change on this endpoint right now. */
  changes: Record<string, string>
  tools: Array<{
    name: string
    title: string | null
    method: string | null
    path: string | null
    description: string
    edited: boolean
  }>
  spec?: string
  note?: string
}

type EndpointRow = McpServer & { tools: McpTool[] }

function inScope(scope: EndpointScope, id: string): boolean {
  return scope.serverIds === null || scope.serverIds.includes(id)
}

async function endpointsInScope(scope: EndpointScope): Promise<string[]> {
  const rows = await db().mcpServer.findMany({
    where: {
      vaultId: scope.ctx.vaultId,
      kind: "openapi",
      ...(scope.serverIds ? { id: { in: scope.serverIds } } : {}),
    },
    select: { slug: true },
    orderBy: { slug: "asc" },
  })

  return rows.map((row) => row.slug)
}

async function findEndpoint(
  scope: EndpointScope,
  slug: string,
): Promise<EndpointRow> {
  const row = await db().mcpServer.findUnique({
    where: { vaultId_slug: { vaultId: scope.ctx.vaultId, slug } },
    include: { tools: { orderBy: { name: "asc" } } },
  })

  if (!row || row.kind !== "openapi" || !inScope(scope, row.id)) {
    const known = await endpointsInScope(scope)
    throw new PcpError(
      "not_found",
      `No API endpoint called ${slug}. Endpoints: ${known.join(", ") || "(none)"}.`,
    )
  }

  return row
}

/** What a token may change on this endpoint, in words for the assistant. */
function describeChanges(server: McpServer): Record<string, string> {
  const hasSecret = server.authType === "header"

  return {
    name: "yes",
    description: "yes",
    toolDescriptions: "yes",
    spec:
      server.specSource === "upload"
        ? "yes, as OpenAPI text"
        : "no: the owner set a schema URL; only they can change it",
    baseUrl: hasSecret
      ? "no: a secret is attached, so only the owner can change where requests go"
      : server.publicOnly
        ? "yes, to a public address"
        : "no: the owner set this address",
    readOnly:
      hasSecret && server.readOnly
        ? "can stay on; only the owner can turn it off"
        : "yes",
    authentication: "no: only the owner attaches or changes a secret",
  }
}

async function detailsOf(
  scope: EndpointScope,
  server: EndpointRow,
  { includeSpec = false }: { includeSpec?: boolean } = {},
): Promise<EndpointDetails> {
  const spec = await db().openApiSpec.findUnique({
    where: { serverId: server.id },
    select: { text: true, fetchedAt: true },
  })

  const details: EndpointDetails = {
    endpoint: server.slug,
    name: server.name,
    description: server.description,
    baseUrl: server.url,
    readOnly: server.readOnly,
    publicOnly: server.publicOnly,
    enabled: server.enabled,
    schema: {
      source: server.specSource === "url" ? "url" : "upload",
      url: server.specUrl,
      readAt: spec?.fetchedAt.toISOString() ?? null,
    },
    // The header's name, never which secret or what it holds.
    authentication:
      server.authType === "header"
        ? { type: "header", header: server.authHeaderName }
        : { type: "none", header: null },
    status: server.status as ServerStatus,
    statusMessage: server.statusMessage,
    changes: describeChanges(server),
    tools: server.tools.map((tool) => {
      const plan = readCallPlan(tool.operation)

      return {
        name: tool.name,
        title: tool.title,
        method: plan?.method ?? null,
        path: plan?.path ?? null,
        description: tool.descriptionOverride ?? tool.description,
        edited: tool.descriptionOverride !== null,
      }
    }),
  }

  if (includeSpec && spec) {
    if (spec.text.length <= MAX_INCLUDED_SPEC) {
      details.spec = spec.text
    } else {
      details.note = `The stored schema is ${spec.text.length} characters, too long to include here.`
    }
  }

  return details
}

/**
 * A note when the base URL points at a private address, so the assistant
 * learns at once that calls will be refused until the owner allows it. It is
 * only a hint: the real check happens when a request connects.
 */
async function privateAddressNote(baseUrl: string): Promise<string | null> {
  try {
    const host = bareHostname(new URL(baseUrl))
    const found = await Promise.race([
      dns.promises.lookup(host, { all: true }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timeout")),
          ADDRESS_LOOKUP_TIMEOUT_MS,
        ),
      ),
    ])
    const bad = found.find((entry) => !isPublicAddress(entry.address))

    return bad
      ? `${host} resolves to ${bad.address}, a private or local address. Calls will be refused until the owner allows private addresses for this endpoint in PCP.`
      : null
  } catch {
    return null
  }
}

export async function getEndpoint(
  scope: EndpointScope,
  slug: string,
  options: { includeSpec?: boolean } = {},
): Promise<EndpointDetails> {
  return detailsOf(scope, await findEndpoint(scope, slug), options)
}

export type RegisterInput = {
  name: string
  spec: string
  baseUrl?: string | null
  description?: string
  readOnly?: boolean
}

export async function registerEndpoint(
  scope: EndpointScope,
  input: RegisterInput,
): Promise<EndpointDetails & { registered: string; next: string[] }> {
  const { id, sync } = await createEndpoint(scope.ctx, {
    name: input.name,
    description: input.description,
    baseUrl: input.baseUrl?.trim() || null,
    specSource: "upload",
    specText: input.spec,
    readOnly: input.readOnly === true,
    // Always: the destination of what an assistant registers is the
    // assistant's choice, so it may only be a public one until the owner
    // says otherwise.
    publicOnly: true,
    // Never a credential: a secret and an address the assistant chose must
    // not meet.
    authType: "none",
  })

  // A token limited to some servers could not use what it just made.
  if (scope.serverIds !== null) {
    await db().apiTokenServer.create({
      data: { tokenId: scope.tokenId, serverId: id },
    })
  }

  const server = await db().mcpServer.findUniqueOrThrow({
    where: { id },
    include: { tools: { orderBy: { name: "asc" } } },
  })
  const details = await detailsOf(scope, server)
  const address = await privateAddressNote(server.url)

  return {
    ...details,
    registered: `Registered ${server.name} as ${server.slug} with ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${sync.message ? ` ${sync.message}` : ""}`,
    next: [
      ...(address ? [address] : []),
      "Find its tools with search_tools and run them with call_tool.",
      "It sends no credential. If the API needs a key, ask the owner to attach a secret to this endpoint in PCP.",
    ],
  }
}

export type UpdateInput = {
  name?: string
  description?: string
  spec?: string
  baseUrl?: string
  readOnly?: boolean
  /** Tool name -> the new description, or null to go back to the schema's. */
  toolDescriptions?: Record<string, string | null>
}

export async function updateEndpointDetails(
  scope: EndpointScope,
  slug: string,
  changes: UpdateInput,
): Promise<EndpointDetails & { updated: string }> {
  const given = Object.entries(changes).filter(
    ([, value]) => value !== undefined,
  )

  if (given.length === 0) {
    throw invalid(
      "Nothing to change. Pass at least one of name, description, spec, baseUrl, readOnly or toolDescriptions.",
    )
  }

  const server = await findEndpoint(scope, slug)
  const hasSecret = server.authType === "header"

  // Everything is checked before anything is written.
  let baseUrl = server.url

  if (changes.baseUrl !== undefined) {
    const wanted = validateBaseUrl(changes.baseUrl)

    if (wanted !== server.url) {
      if (hasSecret) {
        throw new PcpError(
          "forbidden",
          "This endpoint sends a secret, so only the owner can change where its requests go.",
        )
      }

      if (!server.publicOnly) {
        throw new PcpError(
          "forbidden",
          "The owner set this endpoint's address, so only the owner can change it.",
        )
      }

      baseUrl = wanted
    }
  }

  if (changes.spec !== undefined && server.specSource !== "upload") {
    throw new PcpError(
      "forbidden",
      `This endpoint reads its schema from ${server.specUrl}, which only the owner can change.`,
    )
  }

  const readOnly = changes.readOnly ?? server.readOnly

  if (server.readOnly && !readOnly && hasSecret) {
    throw new PcpError(
      "forbidden",
      "Only the owner can turn read-only off on an endpoint that sends a secret.",
    )
  }

  const input: EndpointInput = {
    name: changes.name ?? server.name,
    description: changes.description ?? server.description,
    baseUrl,
    specSource: server.specSource === "url" ? "url" : "upload",
    specUrl: server.specUrl,
    // Absent: PCP's stored copy of the schema.
    specText: changes.spec ?? null,
    readOnly,
    // Not the assistant's to change in either direction.
    publicOnly: server.publicOnly,
    // The credential is the owner's: carried over untouched.
    authType: hasSecret ? "header" : "none",
    authSecretId: server.authSecretId,
    authHeaderName: server.authHeaderName,
    authValueTemplate: server.authValueTemplate,
  }

  const { sync } = await updateEndpoint(scope.ctx, server.id, input)

  const ignored: string[] = []
  const edits = Object.entries(changes.toolDescriptions ?? {})

  if (edits.length > 0) {
    const names = new Set(
      (
        await db().mcpTool.findMany({
          where: { serverId: server.id },
          select: { name: true },
        })
      ).map((tool) => tool.name),
    )

    for (const [tool, description] of edits) {
      if (names.has(tool)) {
        await setToolDescription(scope.ctx, server.id, tool, description)
      } else {
        ignored.push(tool)
      }
    }
  }

  const fresh = await findEndpoint(scope, slug)
  const details = await detailsOf(scope, fresh)

  return {
    ...details,
    updated: `Updated ${fresh.name}: ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${sync.message ? ` ${sync.message}` : ""}${ignored.length > 0 ? ` No tool called ${ignored.join(", ")}, so those descriptions were not set.` : ""}`,
  }
}
