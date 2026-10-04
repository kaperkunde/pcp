import { isIP } from "node:net"

import type { McpServer, McpTool } from "@/lib/generated/prisma/client"

import type { ResolvedToken } from "./api-tokens"
import type { SyncResult } from "./catalogue"
import { MAX_SPEC_BYTES } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  changeEndpoint,
  createEndpoint,
  downloadSpec,
  generateEndpointTools,
  previewEndpoint,
  readDocument,
  specHash,
  storedSpec,
  type EndpointPreview,
} from "./endpoints"
import { invalid, PcpError } from "./errors"
import { bareHostname, isPublicAddress } from "./openapi/address"
import { fetchSpec } from "./openapi/fetch-spec"
import { isObject } from "./openapi/json"
import { lintDocument, type SchemaProblem } from "./openapi/lint"
import { readPatches, valueAt, type PatchOperation } from "./openapi/patch"
import { readCallPlan } from "./openapi/plan"
import { canonicalJson } from "./permission-rules"
import { validateBaseUrl, validateSpecUrl } from "./openapi/urls"
import {
  authHeaderNames,
  normalizeNameAndDescription,
  setToolDescription,
  type ExtraAuthHeaderInput,
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
 *   goes to (a name PCP does not hold yet is a secret the owner types in on
 *   PCP's page when they agree, never in the conversation); update_endpoint never names, sees or attaches one, and the
 *   writer its changes go through (endpoints.ts changeEndpoint) never
 *   touches the credential, the schema's source or public-only.
 * - Nothing takes effect without the owner. A registration is a request the
 *   owner answers before any endpoint exists (permissions.ts), and any change
 *   to an endpoint that other assistants can see (words, schema, address, or
 *   read-only turned off) disables it again until the owner enables it.
 *   Words an assistant writes reach every other assistant through search,
 *   instructions and tool descriptions, so they are the owner's to approve.
 *
 * A schema comes as text, or as a URL PCP downloads at once, from public
 * addresses only, so the owner is shown the tools it would give. What the
 * owner approves is that copy: the endpoint is made from it, not from a
 * second download, and a later read of the URL that finds another document
 * is not taken without the owner (endpoints.ts syncEndpointTools).
 *
 * A schema is changed by edits, a JSON Patch kept beside it and applied
 * every time tools are generated, so a large schema is fixed or narrowed
 * without being sent again; get_endpoint reads it a part at a time.
 */

/** The most of a schema, or of its edits, one answer includes. */
const MAX_INCLUDED_SPEC = 50_000
/** Keys listed when a part of a schema is too long to include. */
const MAX_OUTLINE_KEYS = 500
/**
 * Endpoints in one vault: what an owner who keeps saying yes to an assistant
 * can be talked into.
 */
const MAX_ENDPOINTS = 50

export type EndpointScope = Pick<ResolvedToken, "ctx" | "tokenId" | "serverIds">

export type EndpointDetails = {
  endpoint: string
  name: string
  /** Left out, with statusMessage and changes, when one part is asked for. */
  description?: string
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
    /** An assistant proposed the URL; a changed document waits for the owner. */
    urlFromAssistant: boolean
    readAt: string | null
    characters: number | null
    /** How many edits are applied to it. */
    edits: number
  }
  /**
   * The headers the credential goes in, the first in `header`; never which
   * secrets or what they hold.
   */
  authentication: {
    type: "none" | "header" | "oauth"
    header: string | null
    headers: string[]
  }
  status: ServerStatus
  statusMessage?: string
  /**
   * What this token can and cannot change on this endpoint right now, with
   * the fields that share an answer listed together ("name, description").
   */
  changes?: Record<string, string>
  toolCount: number
  /** Left out when a part of the schema is asked for, to leave it room. */
  tools?: Array<{
    name: string
    title: string | null
    method: string | null
    path: string | null
    description: string
    edited: boolean
  }>
  spec?: string
  /** The edits, when asked for and not too long. */
  patches?: PatchOperation[]
  /** Likely mistakes in the edited schema, with edits that fix them. */
  problems?: SchemaProblem[]
  /** How many more there are than listed. */
  moreProblems?: number
  /** One part of the edited schema, when asked for by pointer. */
  specPart?:
    | { pointer: string; value: unknown }
    | {
        pointer: string
        tooLong: true
        characters: number
        /** An object's keys, or a list's length, to point further in with. */
        keys?: string[]
        moreKeys?: number
        length?: number
      }
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
    const asks =
      "asks the owner: nothing changes until they agree, and then it stays on"

    return {
      name: asks,
      description: asks,
      toolDescriptions: asks,
      patches: asks,
      refreshSpec:
        server.specSource === "url"
          ? asks
          : "no: the schema was given as text, so there is no URL to read",
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
        : "no: the schema is read from a URL; change it with patches",
    patches: `yes, as a JSON Patch applied to the schema; ${disables.slice(5)}`,
    refreshSpec:
      server.specSource === "url"
        ? "yes; when the document has changed, the endpoint is disabled again until the owner enables it"
        : "no: the schema was given as text, so there is no URL to read",
    baseUrl: `yes, to a public address; ${disables.slice(5)}`,
    readOnly:
      "yes; turning it on takes effect at once, turning it off disables the endpoint until the owner enables it",
    authentication: "no: only the owner attaches or changes a secret",
  }
}

/** Fields that share an answer, as one entry: said once, not five times. */
function groupChanges(changes: Record<string, string>): Record<string, string> {
  const byAnswer = new Map<string, string[]>()

  for (const [field, answer] of Object.entries(changes)) {
    byAnswer.set(answer, [...(byAnswer.get(answer) ?? []), field])
  }

  return Object.fromEntries(
    [...byAnswer].map(([answer, fields]) => [fields.join(", "), answer]),
  )
}

export type ReadOptions = {
  includeSpec?: boolean
  includePatches?: boolean
  /** A JSON Pointer into the edited schema. */
  specPointer?: string
  /** Read specPointer from the schema as stored, before the edits. */
  unedited?: boolean
  /** List likely mistakes in the schema, with the edits that fix them. */
  includeProblems?: boolean
}

async function detailsOf(
  server: EndpointRow,
  {
    includeSpec = false,
    includePatches = false,
    specPointer,
    unedited = false,
    includeProblems = false,
  }: ReadOptions = {},
): Promise<EndpointDetails> {
  const [row, spec, headers] = await Promise.all([
    db().openApiSpec.findUnique({
      where: { serverId: server.id },
      select: { fetchedAt: true },
    }),
    storedSpec(server.id),
    authHeaderNames(server),
  ])

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
      urlFromAssistant: server.specUrlFromAssistant,
      readAt: row?.fetchedAt.toISOString() ?? null,
      characters: spec?.text.length ?? null,
      edits: spec?.patches.length ?? 0,
    },
    // The headers' names, never which secrets or what they hold.
    authentication:
      server.authType === "header"
        ? { type: "header", header: server.authHeaderName, headers }
        : server.authType === "oauth"
          ? {
              type: "oauth",
              header: "Authorization",
              headers: ["Authorization"],
            }
          : { type: "none", header: null, headers: [] },
    status: server.status as ServerStatus,
    statusMessage: server.statusMessage,
    changes: groupChanges(describeChanges(server)),
    toolCount: server.tools.length,
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

  const notes: string[] = []

  // The answer has a length limit, and a large endpoint's tool list alone can
  // reach it: what was asked for comes first.
  if (
    includeSpec ||
    includePatches ||
    includeProblems ||
    specPointer !== undefined
  ) {
    delete details.tools
  }

  // A read for one part of the schema, or its mistakes, is one of many in a
  // row: what the endpoint is and what may be changed were said already.
  if (includeProblems || specPointer !== undefined) {
    delete details.description
    delete details.statusMessage
    delete details.changes
  }

  if (!server.enabled) {
    notes.push(
      "Disabled: nothing uses this endpoint until the owner enables it in PCP.",
    )
  }

  if (includeSpec && spec) {
    if (spec.text.length <= MAX_INCLUDED_SPEC) {
      details.spec = spec.text
    } else {
      notes.push(
        `The stored schema is ${spec.text.length} characters, too long to include here. Read it a part at a time with specPointer, starting with "" or "/paths".`,
      )
    }
  }

  if (includePatches && spec) {
    if (JSON.stringify(spec.patches).length <= MAX_INCLUDED_SPEC) {
      details.patches = spec.patches
    } else {
      notes.push(
        "The edits are too long to include here; replace them all with patches to start over.",
      )
    }
  }

  if (includeProblems && spec) {
    const { problems, more } = lintDocument(
      readDocument(spec.text, spec.patches),
      { blockedHeaders: headers },
    )
    details.problems = problems
    if (more > 0) {
      details.moreProblems = more
    }
    if (problems.some((problem) => problem.fix)) {
      notes.push(
        "Each fix is a list of edits for update_endpoint's addPatches; check one with specPointer before sending it.",
      )
    }
  }

  if (specPointer !== undefined && spec) {
    details.specPart = readPart(
      unedited
        ? readDocument(spec.text, [])
        : readDocument(spec.text, spec.patches),
      specPointer,
    )
  }

  if (notes.length > 0) {
    details.note = notes.join(" ")
  }

  return details
}

/**
 * One part of a schema by JSON Pointer. A part too long to include comes
 * back as an outline (an object's keys, a list's length) to point further in
 * with, so a schema of any size can be read in steps.
 */
function readPart(
  document: unknown,
  pointer: string,
): NonNullable<EndpointDetails["specPart"]> {
  const value = valueAt(document, pointer)

  if (value === undefined) {
    throw invalid(
      `The schema has nothing at ${pointer || '""'}. Pointers escape "/" in a key as ~1, so /paths/~1pets is the /pets path.`,
    )
  }

  const characters = JSON.stringify(value).length

  if (characters <= MAX_INCLUDED_SPEC) {
    return { pointer, value }
  }

  if (Array.isArray(value)) {
    return { pointer, tooLong: true, characters, length: value.length }
  }

  const keys = isObject(value) ? Object.keys(value) : []

  return {
    pointer,
    tooLong: true,
    characters,
    keys: keys.slice(0, MAX_OUTLINE_KEYS),
    ...(keys.length > MAX_OUTLINE_KEYS
      ? { moreKeys: keys.length - MAX_OUTLINE_KEYS }
      : {}),
  }
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
  options: ReadOptions = {},
): Promise<EndpointDetails> {
  return detailsOf(await findEndpoint(scope, slug), options)
}

/** What an assistant asked to register, as the owner is asked about it. */
export type EndpointRegistration = {
  /** The OpenAPI text, as given or as downloaded. */
  spec: string
  /** The address it was downloaded from, as the assistant gave it. */
  specUrl?: string | null
  /** The same, after redirects: what a relative server is resolved against. */
  fetchedFrom?: string | null
  /** Edits applied to it; missing on requests from before there were any. */
  patches?: PatchOperation[]
  readOnly: boolean
  /** What PCP worked out from the text, for the owner to read. */
  preview: EndpointPreview & { privateAddress: string | null }
}

export type RegistrationInput = {
  name: string
  description?: string
  /** The OpenAPI text; or specUrl, not both. */
  spec?: string
  /** A public address PCP downloads the schema from now. */
  specUrl?: string
  /** A JSON Patch to apply to the schema, as given. */
  patches?: unknown
  /** Where requests go; empty means the address in the schema. */
  baseUrl?: string | null
  readOnly?: boolean
  /** The secret by id, with the header it goes in, when there is one. */
  authSecretId?: string | null
  /** Or a secret the owner enters when they agree, by the name it will get. */
  newSecretName?: string | null
  /** Every header the credential goes in, first to last. */
  authHeaderNames?: string[]
  /** Signs in with the schema's OAuth flow; the scope, if one was given. */
  oauth?: { scope: string | null } | null
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
  /** Likely mistakes in the schema as edited, for the assistant. */
  problems: SchemaProblem[]
}> {
  const { name, description } = normalizeNameAndDescription(input)
  const fromUrl = input.specUrl !== undefined

  if (fromUrl === (input.spec !== undefined)) {
    throw invalid(
      "Pass the schema as text in openapi_schema or its address in openapi_url, one of the two.",
    )
  }

  if (!fromUrl && !input.spec!.trim()) {
    throw invalid("openapi_schema is empty. Pass the whole OpenAPI document.")
  }

  if (!fromUrl && Buffer.byteLength(input.spec!, "utf8") > MAX_SPEC_BYTES) {
    throw invalid(
      `The schema is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB. Pass its address in openapi_url and narrow it with patches, or ask the owner to add the API in PCP.`,
    )
  }

  const patches = input.patches === undefined ? [] : readPatches(input.patches)
  const sendsSecret =
    !input.oauth && Boolean(input.authSecretId || input.newSecretName)

  // A secret or a token goes where an address says, and the schema is
  // someone else's document: the address has to come from the request the
  // owner will read.
  if ((sendsSecret || input.oauth) && !input.baseUrl?.trim()) {
    throw invalid(
      input.oauth
        ? "The owner's OAuth token is sent to an address you name: pass the base URL in url, so the owner sees where it will go."
        : "A secret is sent to an address you name: pass the base URL in url, so the owner sees where it will go.",
    )
  }

  await assertRoomForEndpoint(ctx)

  // Downloaded now, from a public address only, so the owner is asked about
  // the document itself; it is never sent to the assistant.
  const specUrl = fromUrl ? validateSpecUrl(input.specUrl!) : null
  const fetched = specUrl
    ? await fetchSpec(specUrl, { publicOnly: true })
    : null
  const text = fetched?.text ?? input.spec!

  const readOnly = input.readOnly === true
  let preview: EndpointPreview

  try {
    preview = previewEndpoint(text, {
      readOnly,
      ownerBaseUrl: input.baseUrl,
      hasSecret: sendsSecret,
      authHeaderNames: input.authHeaderNames,
      oauth: input.oauth ?? undefined,
      patches,
      fetchedFrom: fetched?.url ?? null,
    })
  } catch (error) {
    // A parser's message quotes the text it stopped at. The assistant chose
    // the address but has not seen what PCP got from it, which may be more
    // than it could fetch itself: say that it did not read, not what it held.
    if (
      fetched &&
      error instanceof PcpError &&
      /could not be read as JSON or YAML/.test(error.message)
    ) {
      throw invalid(
        "The document at that address could not be read as JSON or YAML.",
      )
    }

    throw error
  }

  return {
    name,
    description,
    url: preview.baseUrl,
    problems: lintDocument(readDocument(text, patches), {
      blockedHeaders: input.authHeaderNames ?? [],
    }).problems,
    registration: {
      spec: text,
      specUrl,
      fetchedFrom: fetched?.url ?? null,
      patches,
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
    authType: "none" | "header" | "oauth"
    authHeaderName?: string | null
    authValueTemplate?: string | null
    authSecretId?: string | null
    authExtraHeaders?: ExtraAuthHeaderInput[] | null
    /** oauth: the owner's client, and the scope they were shown. */
    oauthClientId?: string | null
    oauthClientSecretId?: string | null
    oauthScope?: string | null
    endpoint: EndpointRegistration
  },
): Promise<{ id: string; sync: SyncResult }> {
  await assertRoomForEndpoint(ctx)

  const { endpoint } = asked

  return createEndpoint(ctx, {
    name: asked.name,
    description: asked.description,
    baseUrl: asked.url,
    ...(endpoint.specUrl
      ? {
          specSource: "url",
          specUrl: endpoint.specUrl,
          fetched: {
            text: endpoint.spec,
            url: endpoint.fetchedFrom ?? endpoint.specUrl,
          },
          specUrlFromAssistant: true,
        }
      : { specSource: "upload", specText: endpoint.spec }),
    patches: endpoint.patches ?? [],
    readOnly: endpoint.readOnly,
    publicOnly: true,
    authType: asked.authType,
    authHeaderName: asked.authHeaderName,
    authValueTemplate: asked.authValueTemplate,
    authSecretId: asked.authSecretId,
    authExtraHeaders: asked.authExtraHeaders,
    oauthClientId: asked.oauthClientId,
    oauthClientSecretId: asked.oauthClientSecretId,
    // The scope the owner was shown, which is what the schema asked for when
    // none was given.
    oauthScope: asked.oauthScope ?? endpoint.preview.oauth?.scope ?? null,
  })
}

export type UpdateInput = {
  name?: string
  description?: string
  spec?: string
  /** Every edit, replacing the ones the endpoint has; [] removes them all. */
  patches?: unknown
  /** Edits applied after the ones the endpoint has. */
  addPatches?: unknown
  /** Download the schema's URL again. */
  refreshSpec?: boolean
  baseUrl?: string
  readOnly?: boolean
  /** Tool name -> the new description, or null to go back to the schema's. */
  toolDescriptions?: Record<string, string | null>
}

export async function updateEndpointDetails(
  scope: EndpointScope,
  slug: string,
  changes: UpdateInput,
): Promise<
  (EndpointDetails & { updated: string }) | { ask: EndpointChangeAsk }
> {
  // Asking not to refresh is asking for nothing.
  const given = (Object.keys(changes) as Array<keyof UpdateInput>).filter(
    (key) =>
      changes[key] !== undefined &&
      !(key === "refreshSpec" && changes.refreshSpec === false),
  )

  if (given.length === 0) {
    throw invalid(
      "Nothing to change. Pass at least one of name, description, spec, patches, addPatches, refreshSpec, baseUrl, readOnly or toolDescriptions.",
    )
  }

  if (changes.patches !== undefined && changes.addPatches !== undefined) {
    throw invalid(
      "Pass patches to replace every edit, or addPatches to add to them, not both.",
    )
  }

  const server = await findEndpoint(scope, slug)
  const widens = changes.readOnly === false && server.readOnly

  // Everything is checked before anything is written.
  if (belongsTo(server) === "owner") {
    const refused = given.filter(
      (key) =>
        !PROPOSABLE.has(key) &&
        !(key === "readOnly" && (changes.readOnly === true || !widens)),
    )

    if (refused.length > 0) {
      throw new PcpError(
        "forbidden",
        `This endpoint is the owner's: it sends a secret, or reaches private addresses they allowed. You can read it, turn read-only on, and ask the owner to change its name, description, edits or tool descriptions, or to read its schema again, but ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} theirs to change.`,
      )
    }

    // The rest of what it asks for is put to the owner.
    if (given.some((key) => PROPOSABLE.has(key))) {
      return proposeChange(scope, server, changes)
    }
  }

  if (changes.spec !== undefined && server.specSource !== "upload") {
    throw new PcpError(
      "forbidden",
      "This endpoint reads its schema from a URL: change it with patches or addPatches, or read the URL again with refreshSpec.",
    )
  }

  if (changes.refreshSpec === true && server.specSource !== "url") {
    throw new PcpError(
      "forbidden",
      "This endpoint's schema was given as text, so there is no URL to read again.",
    )
  }

  const stored = await storedSpec(server.id)
  const patches =
    changes.patches !== undefined
      ? readPatches(changes.patches)
      : changes.addPatches !== undefined
        ? // Checked alone first, so an error names the edit as it was sent.
          readPatches([
            ...(stored?.patches ?? []),
            ...readPatches(changes.addPatches),
          ])
        : undefined
  const fetched =
    changes.refreshSpec === true ? await downloadSpec(server) : undefined

  const baseUrl =
    changes.baseUrl === undefined ? undefined : validateBaseUrl(changes.baseUrl)
  const moves = baseUrl !== undefined && baseUrl !== server.url
  const toolEdits = Object.entries(changes.toolDescriptions ?? {})
  const edits =
    patches !== undefined &&
    JSON.stringify(patches) !== JSON.stringify(stored?.patches ?? [])
  const newDocument =
    fetched !== undefined && specHash(fetched.text) !== stored?.hash

  // A change other assistants would see, or that widens what the endpoint
  // does, waits for the owner. Turning read-only on only narrows it.
  const material =
    (changes.name !== undefined && changes.name.trim() !== server.name) ||
    (changes.description !== undefined &&
      changes.description.trim() !== server.description) ||
    changes.spec !== undefined ||
    edits ||
    newDocument ||
    moves ||
    toolEdits.length > 0 ||
    widens

  // Turned off in the change's first write, so one that fails halfway is
  // never live; one refused before anything is written changes nothing.
  const disables = material && server.enabled

  const { sync } = await changeEndpoint(scope.ctx, server.id, {
    name: changes.name,
    description: changes.description,
    baseUrl: moves ? baseUrl : undefined,
    readOnly: changes.readOnly,
    specText: changes.spec,
    fetched: newDocument ? fetched : undefined,
    patches: edits ? patches : undefined,
    disable: disables,
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
  const unchanged =
    fetched !== undefined && !newDocument
      ? " The document at the schema's URL has not changed."
      : ""

  return {
    ...details,
    updated: `Updated ${fresh.name}: ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${sync.message ? ` ${sync.message}` : ""}${unchanged}${disables ? " The endpoint is disabled until the owner enables it again in PCP." : ""}${ignored.length > 0 ? ` No tool called ${ignored.join(", ")}, so those descriptions were not set.` : ""}`,
  }
}

/**
 * What update_endpoint may ask the owner to change on an endpoint of
 * theirs. Never the address, a whole new schema or the credential: the
 * owner reads every edit and description in full, while a new address or
 * document is not something a page of lines can show them.
 */
const PROPOSABLE = new Set<string>([
  "name",
  "description",
  "patches",
  "addPatches",
  "refreshSpec",
  "toolDescriptions",
])
/** New edits in one request: each is a line the owner reads. */
const MAX_PROPOSED_EDITS = 100
/** One edit's value, as JSON, shown in full. */
const MAX_PROPOSED_VALUE = 4000
/** Tool descriptions in one request, each shown in full. */
const MAX_PROPOSED_DESCRIPTIONS = 20
/** Tools named in each of the lists the owner is shown. */
const MAX_LISTED_TOOLS = 20

/**
 * A change to an endpoint of the owner's, as they are asked about it and as
 * it will be made: only what is here, and only to the endpoint as it was
 * when they were asked.
 */
export type EndpointChangeAsk = {
  serverId: string
  /** The endpoint when the owner was asked (basisOf): a change since then refuses. */
  basis: string
  name?: string
  description?: string
  readOnly?: true
  /** Every edit, replacing the ones it has. */
  patches?: PatchOperation[]
  /** A new download of the schema URL, by its fingerprint: fetched again when allowed. */
  fetched?: { hash: string }
  toolDescriptions?: Record<string, string | null>
  /** What the owner is shown, worked out when it was asked. */
  shown: { title: string; lines: string[]; warning: string | null }
}

/** What a change is made against: the schema, its edits and the words. */
function basisOf(
  server: McpServer,
  stored: { hash: string; patches: PatchOperation[] } | null,
): string {
  return specHash(
    JSON.stringify([
      stored?.hash ?? null,
      stored?.patches ?? [],
      server.readOnly,
      server.name,
      server.description,
      server.url,
    ]),
  )
}

/** The operations in `after` that are not in `before`, and the reverse. */
function editsDiff(before: PatchOperation[], after: PatchOperation[]) {
  const left = new Map<string, PatchOperation[]>()

  for (const op of before) {
    const key = canonicalJson(op)
    left.set(key, [...(left.get(key) ?? []), op])
  }

  const added: PatchOperation[] = []

  for (const op of after) {
    const same = left.get(canonicalJson(op))

    if (same && same.length > 0) {
      same.pop()
    } else {
      added.push(op)
    }
  }

  return { added, removed: [...left.values()].flat() }
}

function describeEdit(op: PatchOperation): string {
  switch (op.op) {
    case "remove":
      return `remove ${op.path}`
    case "move":
    case "copy":
      return `${op.op} ${op.from} to ${op.path}`
    default:
      return `${op.op} ${op.path}: ${JSON.stringify(op.value)}`
  }
}

function listed(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_TOOLS)
  const more = names.length - shown.length
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`
}

async function proposeChange(
  scope: EndpointScope,
  server: EndpointRow,
  changes: UpdateInput,
): Promise<
  (EndpointDetails & { updated: string }) | { ask: EndpointChangeAsk }
> {
  const stored = await storedSpec(server.id)

  if (!stored) {
    throw invalid("PCP has no copy of this schema to change.")
  }

  if (changes.refreshSpec === true && server.specSource !== "url") {
    throw new PcpError(
      "forbidden",
      "This endpoint's schema was given as text, so there is no URL to read again.",
    )
  }

  const words = normalizeNameAndDescription({
    name: changes.name ?? server.name,
    description: changes.description ?? server.description,
  })
  const name =
    changes.name !== undefined && words.name !== server.name
      ? words.name
      : undefined
  const description =
    changes.description !== undefined &&
    words.description !== server.description
      ? words.description
      : undefined

  const patches =
    changes.patches !== undefined
      ? readPatches(changes.patches)
      : changes.addPatches !== undefined
        ? readPatches([...stored.patches, ...readPatches(changes.addPatches)])
        : stored.patches
  const edits = editsDiff(stored.patches, patches)

  if (edits.added.length > MAX_PROPOSED_EDITS) {
    throw invalid(
      `That is ${edits.added.length} new edits; the owner reads each one, so ask for at most ${MAX_PROPOSED_EDITS} at a time.`,
    )
  }

  if (
    edits.added.some(
      (op) =>
        "value" in op &&
        (JSON.stringify(op.value)?.length ?? 0) > MAX_PROPOSED_VALUE,
    )
  ) {
    throw invalid(
      `An edit's value is longer than ${MAX_PROPOSED_VALUE} characters as JSON; the owner reads it in full, so split it into smaller edits.`,
    )
  }

  const downloaded =
    changes.refreshSpec === true ? await downloadSpec(server) : undefined
  const fetched =
    downloaded && specHash(downloaded.text) !== stored.hash
      ? downloaded
      : undefined
  const readOnly =
    changes.readOnly === true && !server.readOnly ? true : undefined
  const toolEdits = Object.entries(changes.toolDescriptions ?? {})

  if (toolEdits.length > MAX_PROPOSED_DESCRIPTIONS) {
    throw invalid(
      `Ask for at most ${MAX_PROPOSED_DESCRIPTIONS} tool descriptions at a time; the owner reads each one.`,
    )
  }

  const editsChange = edits.added.length > 0 || edits.removed.length > 0

  if (
    name === undefined &&
    description === undefined &&
    !editsChange &&
    !fetched &&
    !readOnly &&
    toolEdits.length === 0
  ) {
    return {
      ...(await detailsOf(server)),
      updated: `Nothing to change: ${server.name} already has what you asked for.${downloaded ? " The document at the schema's URL has not changed." : ""}`,
    }
  }

  // Refused here, before the owner is asked, when it would not work.
  const generated = generateEndpointTools(fetched?.text ?? stored.text, {
    readOnly: readOnly ?? server.readOnly,
    authHeaderNames: await authHeaderNames(server),
    patches,
  })
  const after = new Map(generated.tools.map((tool) => [tool.name, tool]))
  const unknown = toolEdits
    .map(([tool]) => tool)
    .filter((tool) => !after.has(tool))

  if (unknown.length > 0) {
    throw invalid(
      `No tool called ${unknown.join(", ")} after this change. get_endpoint lists the tools.`,
    )
  }

  const before = new Map(server.tools.map((tool) => [tool.name, tool]))
  const added = generated.tools.filter((tool) => !before.has(tool.name))
  const removed = server.tools.filter((tool) => !after.has(tool.name))
  const changed = generated.tools.flatMap((tool) => {
    const old = before.get(tool.name)

    if (!old) {
      return []
    }

    const what = [
      old.operation !== JSON.stringify(tool.operation)
        ? "how it is called"
        : "",
      old.inputSchema !== JSON.stringify(tool.inputSchema) ? "arguments" : "",
      old.description !== tool.description ? "description" : "",
    ].filter(Boolean)

    return what.length > 0 ? [`${tool.name} (${what.join(", ")})`] : []
  })
  const writes = added.filter((tool) => tool.operation.method !== "GET")
  const lines = [
    `Endpoint: ${server.name} (${server.url})`,
    ...(name !== undefined ? [`New name: ${name}`] : []),
    ...(description !== undefined
      ? [`New description:\n${description || "(none)"}`]
      : []),
    ...(readOnly ? ["Read-only: on, so only GET operations stay tools"] : []),
    ...(fetched
      ? [
          `Schema: the document at ${withoutQuery(server.specUrl)} has changed since you approved it; take the new one`,
        ]
      : []),
    ...edits.added.map((op) => `New edit: ${describeEdit(op)}`),
    ...edits.removed.map((op) => `Takes out the edit: ${describeEdit(op)}`),
    ...toolEdits.map(([tool, text]) =>
      text === null
        ? `Description of ${tool}: back to the schema's own`
        : `Description of ${tool}:\n${text.trim().slice(0, 2000)}`,
    ),
    `Tools: ${server.tools.length} now, ${generated.tools.length} after`,
    ...(added.length > 0
      ? [
          `Adds: ${listed(added.map((tool) => `${tool.name} (${tool.operation.method} ${tool.operation.path})`))}`,
        ]
      : []),
    ...(removed.length > 0
      ? [`Takes out: ${listed(removed.map((tool) => tool.name))}`]
      : []),
    ...(changed.length > 0 ? [`Changes: ${listed(changed)}`] : []),
    ...(generated.skipped.length > 0
      ? [`Left out of the schema: ${generated.skipped.length} operations`]
      : []),
  ]

  return {
    ask: {
      serverId: server.id,
      basis: basisOf(server, stored),
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(readOnly ? { readOnly } : {}),
      ...(editsChange ? { patches } : {}),
      ...(fetched ? { fetched: { hash: specHash(fetched.text) } } : {}),
      ...(toolEdits.length > 0
        ? { toolDescriptions: Object.fromEntries(toolEdits) }
        : {}),
      shown: {
        title: `Change the API endpoint ${server.name}?`,
        lines,
        warning:
          writes.length > 0
            ? `This adds ${writes.length} tool${writes.length === 1 ? "" : "s"} that can create, change or delete things at ${new URL(server.url).host}${server.authType === "header" ? ", sending your secret" : server.authType === "oauth" ? ", signed in as you" : ""}.`
            : null,
      },
    },
  }
}

/**
 * Makes a change the owner agreed to: exactly what they were shown, to the
 * endpoint as it was then. It stays on, since the owner just said yes.
 */
export async function applyEndpointChange(
  ctx: VaultContext,
  ask: EndpointChangeAsk,
): Promise<string> {
  const server = await db().mcpServer.findFirst({
    where: { id: ask.serverId, vaultId: ctx.vaultId, kind: "openapi" },
  })

  if (!server) {
    throw new PcpError(
      "state",
      "The endpoint this was for no longer exists, so nothing changed.",
    )
  }

  if (basisOf(server, await storedSpec(server.id)) !== ask.basis) {
    throw new PcpError(
      "state",
      `${server.name} has changed since this was asked, so nothing changed. The assistant can ask again.`,
    )
  }

  let fetched: { text: string; url: string } | undefined

  if (ask.fetched) {
    fetched = await downloadSpec(server)

    if (specHash(fetched.text) !== ask.fetched.hash) {
      throw new PcpError(
        "state",
        "The schema at its URL has changed again since this was asked, so nothing changed. The assistant can ask again.",
      )
    }
  }

  const { sync } = await changeEndpoint(ctx, server.id, {
    name: ask.name,
    description: ask.description,
    readOnly: ask.readOnly,
    patches: ask.patches,
    fetched,
  })

  for (const [tool, text] of Object.entries(ask.toolDescriptions ?? {})) {
    const exists = await db().mcpTool.count({
      where: { serverId: server.id, name: tool },
    })

    if (exists > 0) {
      await setToolDescription(ctx, server.id, tool, text)
    }
  }

  const fresh = await db().mcpServer.findUniqueOrThrow({
    where: { id: server.id },
    select: { name: true },
  })

  return `Changed ${fresh.name}: ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${sync.message ? ` ${sync.message}` : ""}`
}
