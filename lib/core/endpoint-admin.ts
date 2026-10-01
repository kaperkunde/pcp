import { isIP } from "node:net"

import type { McpServer, McpTool } from "@/lib/generated/prisma/client"

import type { ResolvedToken } from "./api-tokens"
import type { SyncResult } from "./catalogue"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  changeEndpoint,
  createEndpoint,
  previewEndpoint,
  type EndpointPreview,
} from "./endpoints"
import { invalid, PcpError } from "./errors"
import { bareHostname, isPublicAddress } from "./openapi/address"
import { readCallPlan } from "./openapi/plan"
import { validateBaseUrl } from "./openapi/urls"
import {
  normalizeNameAndDescription,
  setToolDescription,
  type ServerStatus,
} from "./servers"

/**
 * What an assistant may do to API endpoints through the gateway: register
 * one (register_server with OpenAPI text, which waits for the owner), and
 * read and change one (get_endpoint and update_endpoint).
 *
 * An assistant is not the owner. It decides what goes into a tool call, and
 * a prompt injected into it could decide worse. So what it may do here is
 * narrower than what the owner can do in the UI, and drawn around who an
 * endpoint belongs to:
 *
 * - An endpoint is the **assistant's** while it sends no secret and is still
 *   limited to public addresses. The assistant registered it, and may
 *   rewrite it.
 * - It is the **owner's** once it sends one of their secrets or the owner
 *   allows private addresses. From then on the assistant can read it and
 *   turn read-only on, and nothing else: a new schema could add operations
 *   the owner's key can then perform, and a new address or description could
 *   send the key, or another assistant, somewhere else.
 *
 * And three rules hold for both:
 *
 * - No credential changes, ever. A secret only comes with a registration the
 *   owner approves, named by its NAME and shown to them with the address it
 *   goes to; update_endpoint never names, sees or attaches one, and the
 *   writer its changes go through (endpoints.ts changeEndpoint) never
 *   touches the credential, the schema's source or public-only.
 * - Nothing takes effect without the owner. A registration is a request the
 *   owner answers before any endpoint exists (permissions.ts), and any change
 *   to an endpoint that other assistants can see (words, schema, address, or
 *   read-only turned off) disables it again until the owner enables it.
 *   Words an assistant writes reach every other assistant through search,
 *   instructions and tool descriptions, so they are the owner's to approve.
 * - It only supplies a schema as text. PCP never fetches an address it chose.
 */

const MAX_INCLUDED_SPEC = 50_000
/**
 * Endpoints in one vault: what an owner who keeps saying yes to an assistant
 * can be talked into.
 */
const MAX_ENDPOINTS = 50
/**
 * The longest schema an assistant may register as text. It is held, encrypted,
 * on a request row until the owner answers, and no model writes more.
 */
const MAX_REGISTERED_SPEC_CHARS = 1_000_000

export type EndpointScope = Pick<ResolvedToken, "ctx" | "tokenId" | "serverIds">

export type EndpointDetails = {
  endpoint: string
  name: string
  description: string
  baseUrl: string
  readOnly: boolean
  /** Refuses private, local and link-local addresses; only the owner clears it. */
  publicOnly: boolean
  /** Off: nothing uses it until the owner enables it in PCP. */
  enabled: boolean
  /** Whose it is: the assistant's to rewrite, or the owner's to change. */
  belongsTo: "assistant" | "owner"
  schema: {
    source: "url" | "upload"
    /** Without a query or fragment, which can hold a token. */
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

function belongsTo(server: McpServer): "assistant" | "owner" {
  return server.publicOnly && server.authType === "none" ? "assistant" : "owner"
}

function inScope(scope: EndpointScope, id: string): boolean {
  return scope.serverIds === null || scope.serverIds.includes(id)
}

/** What an assistant may know about an endpoint's address list: no tokens. */
function withoutQuery(address: string | null): string | null {
  if (!address) {
    return null
  }

  try {
    const url = new URL(address)
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

async function visibleEndpoints(scope: EndpointScope) {
  const rows = await db().mcpServer.findMany({
    where: {
      vaultId: scope.ctx.vaultId,
      kind: "openapi",
      ...(scope.serverIds ? { id: { in: scope.serverIds } } : {}),
    },
    orderBy: { slug: "asc" },
  })

  // An endpoint the owner configured and then disabled is theirs alone: the
  // assistant cannot see that it is there.
  return rows.filter((row) => row.enabled || belongsTo(row) === "assistant")
}

async function findEndpoint(
  scope: EndpointScope,
  slug: string,
): Promise<EndpointRow> {
  const row = await db().mcpServer.findUnique({
    where: { vaultId_slug: { vaultId: scope.ctx.vaultId, slug } },
    include: { tools: { orderBy: { name: "asc" } } },
  })

  if (
    !row ||
    row.kind !== "openapi" ||
    !inScope(scope, row.id) ||
    (!row.enabled && belongsTo(row) === "owner")
  ) {
    const known = (await visibleEndpoints(scope)).map((entry) => entry.slug)
    throw new PcpError(
      "not_found",
      `No API endpoint called ${slug}. Endpoints: ${known.join(", ") || "(none)"}.`,
    )
  }

  return row
}

/** What a token may change on this endpoint, in words for the assistant. */
function describeChanges(server: McpServer): Record<string, string> {
  if (belongsTo(server) === "owner") {
    const theirs =
      "no: the owner configured this endpoint (it sends a secret, or reaches private addresses they allowed)"

    return {
      name: theirs,
      description: theirs,
      toolDescriptions: theirs,
      spec: theirs,
      baseUrl: theirs,
      readOnly: server.readOnly
        ? "already on"
        : "yes, on only; turning it off is the owner's",
      authentication: "no: only the owner attaches or changes a secret",
    }
  }

  const disables =
    "yes; the endpoint is disabled again until the owner enables it"

  return {
    name: disables,
    description: disables,
    toolDescriptions: disables,
    spec:
      server.specSource === "upload"
        ? `yes, as OpenAPI text; ${disables.slice(5)}`
        : "no: the owner set a schema URL; only they can change it",
    baseUrl: `yes, to a public address; ${disables.slice(5)}`,
    readOnly:
      "yes; turning it on takes effect at once, turning it off disables the endpoint until the owner enables it",
    authentication: "no: only the owner attaches or changes a secret",
  }
}

async function detailsOf(
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
    belongsTo: belongsTo(server),
    schema: {
      source: server.specSource === "url" ? "url" : "upload",
      url: withoutQuery(server.specUrl),
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

  if (!server.enabled) {
    details.note =
      "Disabled: nothing uses this endpoint until the owner enables it in PCP."
  }

  if (includeSpec && spec) {
    if (spec.text.length <= MAX_INCLUDED_SPEC) {
      details.spec = spec.text
    } else {
      details.note = `${details.note ? `${details.note} ` : ""}The stored schema is ${spec.text.length} characters, too long to include here.`
    }
  }

  return details
}

/**
 * A note when the base URL is plainly a private address, so the assistant
 * learns at once that calls will be refused until the owner allows it. It
 * only looks at the text: no lookup is made of a name the assistant chose,
 * and what a name resolves to is not told to the assistant either. The real
 * check happens when a request connects.
 */
function privateAddressNote(baseUrl: string): string | null {
  const host = bareHostname(new URL(baseUrl)).toLowerCase()
  const isPrivate = isIP(host)
    ? !isPublicAddress(host)
    : host === "localhost" || host.endsWith(".localhost")

  return isPrivate
    ? `${host} is a private or local address. Calls will be refused until the owner allows private addresses for this endpoint in PCP.`
    : null
}

export async function getEndpoint(
  scope: EndpointScope,
  slug: string,
  options: { includeSpec?: boolean } = {},
): Promise<EndpointDetails> {
  return detailsOf(await findEndpoint(scope, slug), options)
}

/** What an assistant asked to register, as the owner is asked about it. */
export type EndpointRegistration = {
  /** The OpenAPI text, as given. */
  spec: string
  readOnly: boolean
  /** What PCP worked out from the text, for the owner to read. */
  preview: EndpointPreview & { privateAddress: string | null }
}

export type RegistrationInput = {
  name: string
  description?: string
  spec: string
  /** Where requests go; empty means the address in the schema. */
  baseUrl?: string | null
  readOnly?: boolean
  /** The secret by id, with the header it goes in, when there is one. */
  authSecretId?: string | null
  authHeaderName?: string | null
}

async function assertRoomForEndpoint(ctx: VaultContext) {
  const held = await db().mcpServer.count({
    where: { vaultId: ctx.vaultId, kind: "openapi" },
  })

  if (held >= MAX_ENDPOINTS) {
    throw new PcpError(
      "forbidden",
      `PCP holds ${MAX_ENDPOINTS} API endpoints already. Ask the owner to remove some before adding more.`,
    )
  }
}

/**
 * Everything that can be wrong with a registration, found before the owner
 * is asked: the name, the text, the address. No row is made and nothing is
 * fetched; the answer is the request the owner will read and the page will
 * hold. A schema that cannot be used is refused here, so the owner is only
 * ever asked about something that would work.
 */
export async function prepareRegistration(
  ctx: VaultContext,
  input: RegistrationInput,
): Promise<{
  name: string
  description: string
  registration: EndpointRegistration
  url: string
}> {
  const { name, description } = normalizeNameAndDescription(input)

  if (!input.spec.trim()) {
    throw invalid("openapi_schema is empty. Pass the whole OpenAPI document.")
  }

  if (input.spec.length > MAX_REGISTERED_SPEC_CHARS) {
    throw invalid(
      `The schema is ${input.spec.length} characters; an assistant may register up to ${MAX_REGISTERED_SPEC_CHARS}. Leave out operations that are not needed, or ask the owner to add the API in PCP.`,
    )
  }

  // A secret goes where an address says, and the schema is someone else's
  // document: the address has to come from the request the owner will read.
  if (input.authSecretId && !input.baseUrl?.trim()) {
    throw invalid(
      "A secret is sent to an address you name: pass the base URL in url, so the owner sees where it will go.",
    )
  }

  await assertRoomForEndpoint(ctx)

  const readOnly = input.readOnly === true
  const preview = previewEndpoint(input.spec, {
    readOnly,
    ownerBaseUrl: input.baseUrl,
    hasSecret: Boolean(input.authSecretId),
    authHeaderName: input.authHeaderName,
  })

  return {
    name,
    description,
    url: preview.baseUrl,
    registration: {
      spec: input.spec,
      readOnly,
      preview: {
        ...preview,
        privateAddress: privateAddressNote(preview.baseUrl),
      },
    },
  }
}

/**
 * Creates what the owner approved. The address is the one they were shown,
 * and an assistant's endpoint reaches public addresses only (the owner can
 * lift that on the endpoint's page); it starts on, because the owner just
 * said yes.
 */
export async function createApprovedEndpoint(
  ctx: VaultContext,
  asked: {
    name: string
    description?: string
    url: string
    authType: "none" | "header"
    authHeaderName?: string | null
    authValueTemplate?: string | null
    authSecretId?: string | null
    endpoint: EndpointRegistration
  },
): Promise<{ id: string; sync: SyncResult }> {
  await assertRoomForEndpoint(ctx)

  return createEndpoint(ctx, {
    name: asked.name,
    description: asked.description,
    baseUrl: asked.url,
    specSource: "upload",
    specText: asked.endpoint.spec,
    readOnly: asked.endpoint.readOnly,
    publicOnly: true,
    authType: asked.authType,
    authHeaderName: asked.authHeaderName,
    authValueTemplate: asked.authValueTemplate,
    authSecretId: asked.authSecretId,
  })
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
  const given = (Object.keys(changes) as Array<keyof UpdateInput>).filter(
    (key) => changes[key] !== undefined,
  )

  if (given.length === 0) {
    throw invalid(
      "Nothing to change. Pass at least one of name, description, spec, baseUrl, readOnly or toolDescriptions.",
    )
  }

  const server = await findEndpoint(scope, slug)
  const widens = changes.readOnly === false && server.readOnly

  // Everything is checked before anything is written.
  if (belongsTo(server) === "owner") {
    const refused = given.filter(
      (key) => !(key === "readOnly" && (changes.readOnly === true || !widens)),
    )

    if (refused.length > 0) {
      throw new PcpError(
        "forbidden",
        `This endpoint is the owner's: it sends a secret, or reaches private addresses they allowed. You can read it and turn read-only on, but ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} theirs to change.`,
      )
    }
  }

  if (changes.spec !== undefined && server.specSource !== "upload") {
    throw new PcpError(
      "forbidden",
      "The owner set this endpoint's schema URL, so only they can change the schema.",
    )
  }

  const baseUrl =
    changes.baseUrl === undefined ? undefined : validateBaseUrl(changes.baseUrl)
  const moves = baseUrl !== undefined && baseUrl !== server.url
  const toolEdits = Object.entries(changes.toolDescriptions ?? {})

  // A change other assistants would see, or that widens what the endpoint
  // does, waits for the owner. Turning read-only on only narrows it.
  const material =
    (changes.name !== undefined && changes.name.trim() !== server.name) ||
    (changes.description !== undefined &&
      changes.description.trim() !== server.description) ||
    changes.spec !== undefined ||
    moves ||
    toolEdits.length > 0 ||
    widens

  // Disabled first, so a change that fails halfway is never live.
  const disables = material && server.enabled

  if (disables) {
    await db().mcpServer.update({
      where: { id: server.id },
      data: { enabled: false },
    })
  }

  const { sync } = await changeEndpoint(scope.ctx, server.id, {
    name: changes.name,
    description: changes.description,
    baseUrl: moves ? baseUrl : undefined,
    readOnly: changes.readOnly,
    specText: changes.spec,
  })

  const ignored: string[] = []

  if (toolEdits.length > 0) {
    const names = new Set(
      (
        await db().mcpTool.findMany({
          where: { serverId: server.id },
          select: { name: true },
        })
      ).map((tool) => tool.name),
    )

    for (const [tool, description] of toolEdits) {
      if (names.has(tool)) {
        await setToolDescription(scope.ctx, server.id, tool, description)
      } else {
        ignored.push(tool)
      }
    }
  }

  const fresh = await findEndpoint(scope, slug)
  const details = await detailsOf(fresh)

  return {
    ...details,
    updated: `Updated ${fresh.name}: ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${sync.message ? ` ${sync.message}` : ""}${disables ? " The endpoint is disabled until the owner enables it again in PCP." : ""}${ignored.length > 0 ? ` No tool called ${ignored.join(", ")}, so those descriptions were not set.` : ""}`,
  }
}
