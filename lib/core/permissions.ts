import type { CallToolResult } from "@modelcontextprotocol/server"

import type {
  McpServer,
  McpTool,
  PermissionRequest,
} from "@/lib/generated/prisma/client"

import { readFields, shapeAnswer, type AnswerShape } from "./answers"
import {
  accessReview,
  checkAccessLevels,
  describeAccessAsk,
  describeSavedAccess,
  writeAccessLevels,
  type AccessAsk,
  type AccessLevel,
} from "./access-requests"
import type { SyncResult } from "./catalogue"
import type { PermissionDecision, PermissionKind } from "./constants"
import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import {
  applyEndpointChange,
  createApprovedEndpoint,
  type EndpointChangeAsk,
  type EndpointRegistration,
} from "./endpoint-admin"
import { invalid, isPcpError, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import {
  decideMemoryAsk,
  describeMemoryAsk,
  type MemoryAsk,
  type MemoryChoice,
  type MemoryDecision,
  type MemoryShown,
} from "./memories"
import {
  connectLinks,
  connectResult,
  isConnectResult,
  type ConnectLinks,
  type ServerState,
} from "./connect"
import { waitForOwner } from "./owner-wait"
import {
  canonicalJson,
  decisionsFor,
  isOpen,
  PERMISSION_KEEP_MS,
  PERMISSION_TTL_MS,
  previewArgs,
  requestHash,
  storedResultText,
  summaryText,
  type PermissionStatus,
} from "./permission-rules"
import { summarize } from "./search"
import {
  createSecretNamedAfter,
  deleteSecret,
  findTextSecretByName,
  validateSecretValue,
} from "./secrets"
import { oauthRedirectUrl } from "./oauth-client"
import { createServer, getServer, type ServerInput } from "./servers"
import { writeToolAccess } from "./tool-access"
import { callServerTool, needsConnecting, syncServerTools } from "./upstream"

/**
 * The owner's say before an assistant's call runs. A call to a tool the
 * token may only "ask" about, every new server an assistant wants to add,
 * and every change to a shared memory becomes a pending request row. The
 * assistant is handed a link to /permissions/<id>, where the signed-in
 * owner answers; decidePermission() runs the call, once. Nothing here
 * trusts the assistant: only the owner's answer on that page runs anything.
 *
 * The assistant passes the link on and calls check_permission, which holds
 * the call until the owner has answered (lib/core/owner-wait.ts), so the
 * conversation carries on without them coming back to say so. Prompts in
 * the client (elicitation) and PCP's own panel (MCP Apps) were tried first
 * and dropped: Claude's apps stalled on prompts, and showed a panel they
 * rebuilt with its first question again, unable to ask PCP for the answer.
 *
 * Ported from plekje's confirmation flow (lib/mcp/confirm.ts there). The
 * difference: an answer can also settle the tool for the calls after it
 * ("Always allow", "Block").
 */

/** What the gateway knows about the request it is serving. */
export type PermissionScope = {
  ctx: VaultContext
  tokenId: string
  publicUrl: string
}

/**
 * A new server as an assistant asked for it; never a secret's value. With
 * `endpoint` it is an API from OpenAPI text, and `url` is its base URL. With
 * `newSecretName` it sends a secret PCP does not hold yet: the owner types
 * its value in on PCP's page when they agree, and it is saved by that name.
 */
export type RegisterArgs = ServerInput & {
  secretName?: string | null
  newSecretName?: string | null
  /**
   * The new secret may be left empty: an OAuth client's secret, for a client
   * that has none. With OAuth the secret is the client's, sent only to the
   * token address; with a header it is sent with every call.
   */
  newSecretOptional?: boolean
  endpoint?: EndpointRegistration
}

export type PermissionAsk =
  | ({
      kind: "call"
      server: McpServer
      /** Only the name is read: the gateway keeps a slimmer tool than the row. */
      tool: Pick<McpTool, "name">
      args: Record<string, unknown>
    } & AnswerShape)
  | { kind: "register"; input: RegisterArgs }
  | { kind: "endpoint_change"; input: EndpointChangeAsk }
  | MemoryAsk
  | AccessAsk

/** Runs what the owner allowed. Tests swap in a stub. */
export type PermissionExecutor = {
  callTool: typeof callServerTool
  syncTools: typeof syncServerTools
}

const defaultExecutor: PermissionExecutor = {
  callTool: callServerTool,
  syncTools: syncServerTools,
}

export type PermissionView = {
  id: string
  kind: PermissionKind
  status: PermissionStatus | "expired"
  tokenId: string
  tokenName: string
  serverId: string | null
  serverName: string | null
  tool: string
  title: string
  lines: string[]
  warning: string | null
  /** A memory request's memory, for the page to show its text first. */
  memory: MemoryShown | null
  url: string
  createdAt: Date
  expiresAt: Date
  outcome: string | null
  outcomeIsError: boolean
  decisions: Array<{ value: PermissionDecision; label: string }>
  /** Set once an allowed request left an OAuth server needing connecting. */
  connect: ConnectLinks | null
  /**
   * A new server that sends a secret PCP does not hold yet: the owner types
   * its value in on PCP's page, so that is the only place to agree. `exists`
   * when a secret by that name has been added since, which is then used.
   */
  secretToEnter: {
    name: string
    exists: boolean
    /** It may be left empty (a client without a secret). */
    optional: boolean
    /** Set when it is an OAuth client's secret: the client's ID. */
    clientId: string | null
  } | null
}

type Row = PermissionRequest & {
  server: McpServer | null
  token: { name: string; revokedAt: Date | null; expiresAt: Date | null }
}

const ROW_INCLUDE = {
  server: true,
  token: { select: { name: true, revokedAt: true, expiresAt: true } },
} as const

function aad(id: string): string {
  return `permission_request:${id}`
}

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  }
}

export function permissionUrl(publicUrl: string, id: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/permissions/${encodeURIComponent(id)}`
}

/**
 * One call to an upstream tool, its answer shaped for the assistant
 * (answers.ts): only `fields` when given, base64 text at `decode` decoded,
 * and never more than it should read. An OAuth server that is not connected (or whose sign-in expired)
 * answers with the link to connect it instead of an error.
 */
export async function runCall(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    publicUrl,
    fields,
    decode,
    executor = defaultExecutor,
  }: {
    publicUrl: string
    executor?: PermissionExecutor
  } & AnswerShape,
): Promise<CallToolResult> {
  if (needsConnecting(server)) {
    return connectResult(server, publicUrl)
  }

  try {
    return shapeAnswer(
      await executor.callTool(ctx, server, toolName, args, { publicUrl }),
      { fields, decode },
    )
  } catch (error) {
    if (
      isPcpError(error) &&
      error.code === "unauthorized" &&
      server.authType === "oauth"
    ) {
      return connectResult(server, publicUrl)
    }

    throw error
  }
}

function describeAsk(ask: PermissionAsk): {
  target: string
  args: Record<string, unknown>
} {
  switch (ask.kind) {
    case "call":
      // The same call asking for other fields, or to decode other
      // paths, is another request.
      return {
        target: `${ask.server.id}/${ask.tool.name}${ask.fields ? `\n${canonicalJson(ask.fields)}` : ""}${ask.decode ? `\ndecode ${canonicalJson(ask.decode)}` : ""}`,
        args: ask.args,
      }
    case "register":
      return {
        target: ask.input.url,
        args: ask.input as Record<string, unknown>,
      }
    case "memory_share":
      return {
        target: `memory:${ask.input.memoryId ?? ask.input.path}`,
        args: ask.input as Record<string, unknown>,
      }
    case "memory_change":
      return {
        target: `memory:${ask.input.memoryId}`,
        args: ask.input as Record<string, unknown>,
      }
    case "access":
      return { target: "access", args: ask.input }
    case "endpoint_change":
      return {
        target: `endpoint:${ask.input.serverId}`,
        args: ask.input as Record<string, unknown>,
      }
  }
}

function isMemoryKind(kind: string): kind is MemoryAsk["kind"] {
  return kind === "memory_share" || kind === "memory_change"
}

function toolNameOf(ask: PermissionAsk): string {
  switch (ask.kind) {
    case "call":
      return ask.tool.name
    case "register":
      return "register_server"
    case "access":
      return "propose_tool_access"
    case "endpoint_change":
      return "update_endpoint"
    default:
      return "memory"
  }
}

function readArgs(ctx: VaultContext, row: PermissionRequest) {
  return JSON.parse(
    decryptString(ctx.dek, Buffer.from(row.argsCiphertext), aad(row.id)),
  ) as Record<string, unknown>
}

function readResult(ctx: VaultContext, row: PermissionRequest): string | null {
  return row.resultCiphertext
    ? decryptString(
        ctx.dek,
        Buffer.from(row.resultCiphertext),
        `${aad(row.id)}:result`,
      )
    : null
}

function tokenIsLive(token: Row["token"], now = new Date()): boolean {
  return (
    token.revokedAt === null &&
    (token.expiresAt === null || token.expiresAt.getTime() > now.getTime())
  )
}

async function loadRow(where: {
  id: string
  vaultId: string
  tokenId?: string
}): Promise<Row | null> {
  return db().permissionRequest.findFirst({ where, include: ROW_INCLUDE })
}

function toolLabel(row: Pick<Row, "server" | "toolName">): string {
  return `${row.server?.slug ?? "(removed server)"}/${row.toolName}`
}

/** What the owner is shown: read from the row, the catalogue and the args. */
/**
 * What the owner reads about a new server's OAuth: the first line is the
 * authentication, the rest where the sign-in goes and what to set up with
 * the provider. An endpoint's addresses come from someone else's schema, so
 * they are shown before anyone signs in there.
 */
function registerOAuthLines(input: RegisterArgs, publicUrl: string): string[] {
  const oauth = input.endpoint?.preview.oauth
  const scope = input.oauthScope ?? oauth?.scope ?? null
  const client = input.oauthClientId
    ? input.newSecretName
      ? ` with your client "${input.oauthClientId}"; enter its client secret here when you agree (leave it empty for a client without one)`
      : ` with your client "${input.oauthClientId}" and the secret "${input.secretName ?? "?"}"`
    : ""

  return [
    `Authentication: OAuth${client}; you sign in when you connect it${scope ? ` (scope ${scope})` : ""}`,
    ...(oauth
      ? [
          `Sign-in at: ${oauth.authorizationUrl}`,
          `Tokens from: ${oauth.tokenUrl}${input.oauthClientId ? "; your client secret goes there" : ""}`,
        ]
      : []),
    ...(input.oauthClientId
      ? [`Redirect URI your client needs: ${oauthRedirectUrl(publicUrl)}`]
      : []),
  ]
}

async function summarizeRow(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
): Promise<{
  title: string
  lines: string[]
  warning: string | null
  memory?: MemoryShown
}> {
  const args = readArgs(ctx, row)
  const asker = `Asked by the token "${row.token.name}"`

  if (isMemoryKind(row.kind)) {
    const asked = describeMemoryAsk({
      kind: row.kind,
      input: args,
    } as MemoryAsk)

    return { ...asked, lines: [...asked.lines, asker] }
  }

  if (row.kind === "endpoint_change") {
    const { shown } = args as EndpointChangeAsk

    return { ...shown, lines: [...shown.lines, asker] }
  }

  if (row.kind === "access") {
    const { levels } = args as AccessAsk["input"]
    const servers = await db().mcpServer.findMany({
      where: {
        vaultId: ctx.vaultId,
        id: { in: [...new Set(levels.map((level) => level.serverId))] },
      },
      select: { id: true, name: true, slug: true },
    })
    const asked = describeAccessAsk(levels, servers)

    return { ...asked, lines: [...asked.lines, asker] }
  }

  if (row.kind === "register") {
    const input = args as RegisterArgs
    const oauthLines =
      input.authType === "oauth" ? registerOAuthLines(input, publicUrl) : []
    const auth =
      input.authType === "header" && input.newSecretName
        ? `Authentication: sends a new secret, saved as "${input.newSecretName}", in the ${input.authHeaderName || "Authorization"} header; you enter its value here when you agree`
        : input.authType === "header"
          ? `Authentication: sends your secret "${input.secretName ?? "?"}" in the ${input.authHeaderName || "Authorization"} header`
          : input.authType === "oauth"
            ? oauthLines[0]!
            : "Authentication: none"
    const warning =
      input.authType === "header"
        ? `PCP will send the secret "${input.secretName ?? "?"}" to this address with every call. Only add it if you trust the address.`
        : input.authType === "oauth" && input.endpoint
          ? "PCP will send your OAuth token for this account to this address with every call. Only add it if you trust the address and the sign-in addresses."
          : null

    if (input.endpoint) {
      const { preview, readOnly, specUrl, patches } = input.endpoint
      const edits = patches?.length ?? 0

      return {
        title: `Add the API endpoint ${input.name}?`,
        lines: [
          `Address: ${input.url}`,
          ...(preview.privateAddress ? [preview.privateAddress] : []),
          specUrl
            ? `Schema: downloaded from ${specUrl}; a later change to it waits for you`
            : "Schema: supplied as text",
          ...(edits > 0
            ? [
                `Edits: ${edits} change${edits === 1 ? "" : "s"} to the schema, applied before the tools are made`,
              ]
            : []),
          `Tools: ${preview.toolCount} from the OpenAPI schema it supplied (${preview.methods})`,
          `Operations: ${preview.operations.join(", ")}${preview.more > 0 ? `, and ${preview.more} more` : ""}`,
          ...(preview.skipped ? [`Left out: ${preview.skipped}`] : []),
          readOnly
            ? "Read-only: only GET operations become tools"
            : "Can change things: its tools may create, change and delete at this address",
          auth,
          ...oauthLines.slice(1),
          ...(input.description ? [`Description: ${input.description}`] : []),
          asker,
        ],
        warning,
      }
    }

    return {
      title: `Add the server ${input.name}?`,
      lines: [
        `Address: ${input.url}`,
        auth,
        ...oauthLines.slice(1),
        ...(input.description ? [`Description: ${input.description}`] : []),
        asker,
      ],
      warning,
    }
  }

  const tool = row.serverId
    ? await db().mcpTool.findUnique({
        where: {
          serverId_name: { serverId: row.serverId, name: row.toolName },
        },
      })
    : null
  let destructive = false

  try {
    destructive =
      (JSON.parse(tool?.annotations ?? "{}") as { destructiveHint?: boolean })
        .destructiveHint === true
  } catch {
    destructive = false
  }

  const about = tool
    ? summarize(tool.descriptionOverride ?? tool.description)
    : ""

  return {
    title: `Allow ${toolLabel(row)}?`,
    lines: [
      ...(row.server ? [`Server: ${row.server.name} (${row.server.url})`] : []),
      ...(about ? [`What it does: ${about}`] : []),
      asker,
      ...previewArgs(args),
    ],
    warning: destructive
      ? "The server marks this tool as destructive: it can change or delete things for good."
      : null,
  }
}

async function toView(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
): Promise<PermissionView> {
  const { memory = null, ...summary } = await summarizeRow(ctx, row, publicUrl)
  const kind = row.kind as PermissionKind
  const status =
    row.status === "pending" && !isOpen(row)
      ? "expired"
      : (row.status as PermissionStatus)
  const finished = status === "executed" || status === "failed"

  return {
    id: row.id,
    kind,
    status,
    tokenId: row.tokenId,
    tokenName: row.token.name,
    serverId: row.serverId,
    serverName: row.server?.name ?? null,
    tool: row.toolName,
    ...summary,
    memory,
    url: permissionUrl(publicUrl, row.id),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    outcome: readResult(ctx, row),
    outcomeIsError: row.resultIsError,
    decisions: decisionsFor(kind),
    connect:
      finished && row.server && needsConnecting(row.server)
        ? connectLinks(row.server, publicUrl)
        : null,
    secretToEnter: await secretToEnter(ctx, row),
  }
}

/** A secret the owner types in to agree to a new server, if there is one. */
function newSecretOf(
  ctx: VaultContext,
  row: PermissionRequest,
): { name: string; optional: boolean; clientId: string | null } | null {
  if (row.kind !== "register") {
    return null
  }

  const args = readArgs(ctx, row) as RegisterArgs

  return args.newSecretName
    ? {
        name: args.newSecretName,
        optional: args.newSecretOptional === true,
        clientId:
          args.authType === "oauth" ? (args.oauthClientId ?? null) : null,
      }
    : null
}

async function secretToEnter(
  ctx: VaultContext,
  row: PermissionRequest,
): Promise<PermissionView["secretToEnter"]> {
  const secret = newSecretOf(ctx, row)

  return secret
    ? {
        ...secret,
        exists: (await findTextSecretByName(ctx, secret.name)) !== null,
      }
    : null
}

/** What the assistant is told about a request that is no longer pending. */
function outcomeOf(view: PermissionView): CallToolResult {
  // A memory's or proposed levels' outcome says in full what the owner chose
  // and what happened.
  if (
    (isMemoryKind(view.kind) || view.kind === "access") &&
    view.outcome &&
    view.status !== "running"
  ) {
    return text(view.outcome, view.status === "failed")
  }

  switch (view.status) {
    case "executed":
      return text(`The owner allowed it and it ran.\n${view.outcome ?? ""}`)
    case "failed":
      return text(
        `The owner allowed it, but it did not go through.\n${view.outcome ?? ""}`,
        true,
      )
    case "declined":
      return text(view.outcome ?? "The owner said no, so nothing ran.")
    case "running":
      return text("The owner allowed it; it is running now.")
    case "expired":
      return text(
        "This request expired without an answer, so nothing ran. Ask again if it is still wanted.",
      )
    default:
      return text(
        `Still waiting for the owner. They can answer at ${view.url} until ${view.expiresAt.toISOString()}. Afterwards, call check_permission with id "${view.id}" for the result.`,
      )
  }
}

async function outcomeFromRow(
  ctx: VaultContext,
  id: string,
  publicUrl: string,
): Promise<CallToolResult> {
  const row = await loadRow({ id, vaultId: ctx.vaultId })

  return row
    ? outcomeOf(await toView(ctx, row, publicUrl))
    : text("There is no permission request with that id.", true)
}

function pendingText(view: PermissionView): string {
  if (view.kind === "access") {
    return `Not done yet: the owner saves tool levels themselves.\n\n${summaryText(view)}\n\nGive the owner this link, to open signed in to PCP: ${view.url} Your levels are filled in there and each change is marked; they can adjust any of them, and nothing changes until they save. Then call check_permission with id "${view.id}": it waits while they review, and says what they saved. The request stays open until ${view.expiresAt.toISOString()}.`
  }

  const typed = view.secretToEnter
    ? view.secretToEnter.clientId
      ? ` They type the client secret of their OAuth client in there, if it has one; do not ask them for it here.`
      : ` They type the value of the secret "${view.secretToEnter.name}" in there; do not ask them for it here.`
    : ""

  return `Not done yet: this needs the owner's permission.\n\n${summaryText(view)}\n\nGive the owner this link, to open signed in to PCP and answer there: ${view.url}${typed} Then call check_permission with id "${view.id}": it waits while they answer, and gives the result. The request stays open until ${view.expiresAt.toISOString()}.`
}

/**
 * Asks the owner about a call, a new server or a shared memory. The same
 * request asked again finds the row it already has.
 */
export async function withPermission(
  scope: PermissionScope,
  ask: PermissionAsk,
): Promise<CallToolResult> {
  const { target, args } = describeAsk(ask)
  const argsHash = requestHash(ask.kind, target, args)
  const now = new Date()

  // The same request asked again finds the row it already has, so the owner
  // is not asked twice for one thing.
  const existing = await db().permissionRequest.findFirst({
    where: {
      tokenId: scope.tokenId,
      argsHash,
      status: "pending",
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })

  let id = existing?.id

  if (!id) {
    id = newId()
    await db().permissionRequest.create({
      data: {
        id,
        vaultId: scope.ctx.vaultId,
        tokenId: scope.tokenId,
        kind: ask.kind,
        serverId:
          ask.kind === "call"
            ? ask.server.id
            : ask.kind === "endpoint_change"
              ? ask.input.serverId
              : null,
        toolName: toolNameOf(ask),
        fields:
          ask.kind === "call" && ask.fields ? JSON.stringify(ask.fields) : null,
        decode:
          ask.kind === "call" && ask.decode ? JSON.stringify(ask.decode) : null,
        argsCiphertext: asBytes(
          encryptString(scope.ctx.dek, JSON.stringify(args), aad(id)),
        ),
        argsHash,
        expiresAt: new Date(now.getTime() + PERMISSION_TTL_MS),
      },
    })
  }

  const row = await loadRow({ id, vaultId: scope.ctx.vaultId })

  return text(pendingText(await toView(scope.ctx, row!, scope.publicUrl)))
}

/**
 * The owner's answer on PCP's page. "Always allow" and "Block" also set the
 * tool's level for the token; "Allow once" and "Always allow" run the call,
 * once, however many answers race for it.
 */
export async function decidePermission(
  ctx: VaultContext,
  id: string,
  decision: PermissionDecision,
  {
    publicUrl,
    tokenId,
    secretValue,
    always,
  }: {
    publicUrl: string
    tokenId?: string
    /** The value of a new server's secret, typed in on PCP's page. */
    secretValue?: string
    /** A memory to share: read it in every conversation, ticked on the page. */
    always?: boolean
  },
  executor: PermissionExecutor = defaultExecutor,
): Promise<CallToolResult> {
  const row = await loadRow({
    id,
    vaultId: ctx.vaultId,
    ...(tokenId ? { tokenId } : {}),
  })

  if (!row) {
    return text("There is no permission request with that id.", true)
  }

  if (!isOpen(row)) {
    return outcomeOf(await toView(ctx, row, publicUrl))
  }

  const kind = row.kind as PermissionKind
  // Only a tool call has "always" and "block": any other answer is about
  // this one request.
  const choice: PermissionDecision =
    kind !== "call"
      ? decision === "always"
        ? "allow_once"
        : decision === "block"
          ? "decline"
          : decision
      : decision

  if (!decisionsFor(kind).some((offered) => offered.value === choice)) {
    return text("That is not one of the answers to this request.", true)
  }

  if (!tokenIsLive(row.token)) {
    return finishUnrun(
      ctx,
      row,
      publicUrl,
      "The token that asked is no longer valid, so nothing ran.",
    )
  }

  if (isMemoryKind(kind)) {
    return decideMemory(ctx, row, choice as MemoryDecision, publicUrl, {
      always: always === true,
    })
  }

  if (choice === "block" || choice === "decline") {
    if (choice === "block" && row.serverId) {
      await writeToolAccess(row.tokenId, row.serverId, row.toolName, "blocked")
    }

    return finishUnrun(
      ctx,
      row,
      publicUrl,
      choice === "block"
        ? `The owner blocked ${toolLabel(row)} for this token, so nothing ran.`
        : kind === "access"
          ? "The owner said no, so no tool's level changed."
          : "The owner said no, so nothing ran.",
    )
  }

  // Proposed levels are saved by applyAccessRequest, with what the owner
  // chose on the page; decisionsFor offers nothing else, and this keeps it so.
  if (kind === "access") {
    return text("Tool levels are saved on the request's page in PCP.", true)
  }

  // A secret PCP does not hold yet is typed in on PCP's page; a client's
  // may be left empty, for a client without one.
  const newSecret = newSecretOf(ctx, row)

  if (newSecret) {
    const problem =
      secretValue ||
      !(newSecret.optional || (await findTextSecretByName(ctx, newSecret.name)))
        ? validateSecretValue(secretValue ?? "")
        : null

    if (problem) {
      return text(problem, true)
    }
  }

  if (choice === "always" && row.serverId) {
    await writeToolAccess(row.tokenId, row.serverId, row.toolName, "allowed")
  }

  // One winner, however many answers race for it.
  const claimed = await claim(row.id)

  if (claimed.count !== 1) {
    return outcomeFromRow(ctx, row.id, publicUrl)
  }

  let result: CallToolResult

  try {
    result =
      kind === "call"
        ? await executeCall(ctx, row, publicUrl, executor)
        : kind === "endpoint_change"
          ? text(
              await applyEndpointChange(
                ctx,
                readArgs(ctx, row) as EndpointChangeAsk,
              ),
            )
          : await executeRegister(ctx, row, publicUrl, executor, secretValue)
  } catch (error) {
    if (!isPcpError(error)) {
      console.error("[permissions] running an allowed request failed", {
        id: row.id,
        error,
      })
    }

    result = text(
      isPcpError(error) ? error.message : "Something went wrong inside PCP.",
      true,
    )
  }

  // A call that reached an unconnected server did not run; a new server that
  // now needs connecting was added, which is what the owner agreed to.
  const failed =
    result.isError === true || (kind === "call" && isConnectResult(result))
  const stored = storedResultText(
    result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )

  await db().permissionRequest.update({
    where: { id: row.id },
    data: {
      status: failed ? "failed" : "executed",
      resultIsError: failed,
      resultCiphertext: asBytes(
        encryptString(ctx.dek, stored, `${aad(row.id)}:result`),
      ),
    },
  })

  return result
}

async function executeCall(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
  executor: PermissionExecutor,
): Promise<CallToolResult> {
  if (!row.server) {
    return text(
      "The server this was for no longer exists, so nothing ran.",
      true,
    )
  }

  if (!row.server.enabled) {
    return text(
      `${row.server.name} is switched off in PCP, so nothing ran.`,
      true,
    )
  }

  return runCall(ctx, row.server, row.toolName, readArgs(ctx, row), {
    publicUrl,
    fields: readStoredFields(row.fields),
    decode: readStoredFields(row.decode),
    executor,
  })
}

/**
 * The fields (or decode paths) a waiting call asked for, as stored; none
 * when unreadable.
 */
function readStoredFields(stored: string | null): string[] | undefined {
  if (!stored) {
    return undefined
  }

  try {
    return readFields(JSON.parse(stored))
  } catch {
    return undefined
  }
}

/**
 * The secret a new server sends: the one the request named, or for a new
 * one, the value the owner typed in, saved under the name the assistant
 * proposed (with a number added when that is taken by now). Without a value,
 * a secret of that name the owner has added since is used.
 */
async function secretForRegister(
  ctx: VaultContext,
  asked: RegisterArgs,
  secretValue: string | undefined,
): Promise<{ id: string | null; saved: { id: string; name: string } | null }> {
  if (!asked.newSecretName) {
    return {
      id:
        (asked.authType === "oauth"
          ? asked.oauthClientSecretId
          : asked.authSecretId) ?? null,
      saved: null,
    }
  }

  if (!secretValue) {
    const existing = await findTextSecretByName(ctx, asked.newSecretName)

    if (!existing && !asked.newSecretOptional) {
      throw invalid(`Enter the value of the secret "${asked.newSecretName}".`)
    }

    return { id: existing?.id ?? null, saved: null }
  }

  const saved = await createSecretNamedAfter(ctx, {
    base: asked.newSecretName,
    value: secretValue,
    description:
      asked.authType === "oauth"
        ? `Client secret for the OAuth client ${asked.oauthClientId ?? "?"}.`
        : `Sent to ${asked.name} in the ${asked.authHeaderName || "Authorization"} header.`,
  })

  return { id: saved.id, saved }
}

/** The approved server's credential: a header's secret, or an OAuth client. */
function secretFields(asked: RegisterArgs, secretId: string | null) {
  return asked.authType === "oauth"
    ? {
        authSecretId: null,
        oauthClientId: asked.oauthClientId ?? null,
        oauthClientSecretId: asked.oauthClientId ? secretId : null,
        oauthScope: asked.oauthScope ?? null,
      }
    : { authSecretId: secretId }
}

async function executeRegister(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
  executor: PermissionExecutor,
  secretValue?: string,
): Promise<CallToolResult> {
  const asked = readArgs(ctx, row) as RegisterArgs
  const secret = await secretForRegister(ctx, asked, secretValue)
  let created: { id: string; sync?: SyncResult }

  try {
    created = asked.endpoint
      ? await createApprovedEndpoint(ctx, {
          name: asked.name,
          description: asked.description,
          url: asked.url,
          authType: asked.authType,
          authHeaderName: asked.authHeaderName,
          authValueTemplate: asked.authValueTemplate,
          ...secretFields(asked, secret.id),
          endpoint: asked.endpoint,
        })
      : await createServer(ctx, {
          name: asked.name,
          url: asked.url,
          description: asked.description,
          authType: asked.authType,
          authHeaderName: asked.authHeaderName,
          authValueTemplate: asked.authValueTemplate,
          ...secretFields(asked, secret.id),
        })
  } catch (error) {
    // The secret was typed in for this server alone.
    if (secret.saved) {
      await deleteSecret(ctx, secret.saved.id).catch(() => {})
    }

    throw error
  }

  const { id } = created
  const token = await db().apiToken.findUniqueOrThrow({
    where: { id: row.tokenId },
    select: { allowAllServers: true },
  })

  // A token scoped to chosen servers reaches the one it just added.
  if (!token.allowAllServers) {
    await db().apiTokenServer.create({
      data: { tokenId: row.tokenId, serverId: id },
    })
  }

  await db().permissionRequest.update({
    where: { id: row.id },
    data: { serverId: id },
  })

  const server = await getServer(ctx, id)
  const added = `Added ${server.name} as "${server.slug}"`
  // Its name, which the owner chose to keep; never its value.
  const saved = secret.saved
    ? ` The secret the owner entered is saved in PCP as "${secret.saved.name}".`
    : ""

  if (server.authType === "oauth") {
    return connectResult(server, publicUrl, { lead: added })
  }

  // An endpoint's tools were read from the text the owner just approved.
  const sync =
    created.sync ?? (await executor.syncTools(ctx, server, { publicUrl }))

  if (sync.status !== "ok") {
    return text(
      `${added}, but its tools could not be read yet: ${sync.message}${saved}`,
    )
  }

  return text(
    `${added} with ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${created.sync && sync.message ? ` ${sync.message}` : ""} They ask the owner the first time they are used; search_tools finds them.${saved}`,
  )
}

/**
 * A memory request: every answer does something (shares it, keeps it for
 * the assistant, discards it), so each one claims the row and records what
 * happened, as a call that ran does.
 */
async function decideMemory(
  ctx: VaultContext,
  row: Row,
  decision: MemoryDecision,
  publicUrl: string,
  choice: MemoryChoice,
): Promise<CallToolResult> {
  const claimed = await claim(row.id)

  if (claimed.count !== 1) {
    return outcomeFromRow(ctx, row.id, publicUrl)
  }

  let outcome: { status: "executed" | "declined" | "failed"; text: string }

  try {
    outcome = await decideMemoryAsk(
      ctx,
      row.tokenId,
      { kind: row.kind, input: readArgs(ctx, row) } as MemoryAsk,
      decision,
      choice,
    )
  } catch (error) {
    if (!isPcpError(error)) {
      console.error("[permissions] a memory request failed", {
        id: row.id,
        error,
      })
    }

    outcome = {
      status: "failed",
      text: isPcpError(error)
        ? error.message
        : "Something went wrong inside PCP.",
    }
  }

  const failed = outcome.status === "failed"

  await db().permissionRequest.update({
    where: { id: row.id },
    data: {
      status: outcome.status,
      resultIsError: failed,
      resultCiphertext: asBytes(
        encryptString(ctx.dek, outcome.text, `${aad(row.id)}:result`),
      ),
    },
  })

  return text(outcome.text, failed)
}

/** Marks an open request as running: the answer that gets it wins. */
function claim(id: string) {
  return db().permissionRequest.updateMany({
    where: { id, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "running", via: "web", decidedAt: new Date() },
  })
}

/** Closes a request without running it. */
async function finishUnrun(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
  message: string,
): Promise<CallToolResult> {
  const updated = await db().permissionRequest.updateMany({
    where: { id: row.id, status: "pending" },
    data: {
      status: "declined",
      via: "web",
      decidedAt: new Date(),
      resultCiphertext: asBytes(
        encryptString(ctx.dek, message, `${aad(row.id)}:result`),
      ),
    },
  })

  if (updated.count !== 1) {
    return outcomeFromRow(ctx, row.id, publicUrl)
  }

  return text(message)
}

export async function getPermissionView(
  ctx: VaultContext,
  id: string,
  { publicUrl, tokenId }: { publicUrl: string; tokenId?: string },
): Promise<PermissionView | null> {
  const row = await loadRow({
    id,
    vaultId: ctx.vaultId,
    ...(tokenId ? { tokenId } : {}),
  })

  return row ? toView(ctx, row, publicUrl) : null
}

/** A token's requests still waiting for an answer, oldest first. */
export async function listOpenPermissions(
  ctx: VaultContext,
  tokenId: string,
  publicUrl: string,
): Promise<PermissionView[]> {
  const rows = await db().permissionRequest.findMany({
    where: {
      vaultId: ctx.vaultId,
      tokenId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    include: ROW_INCLUDE,
    orderBy: { createdAt: "asc" },
  })

  return Promise.all(rows.map((row) => toView(ctx, row, publicUrl)))
}

/**
 * check_permission: where a request stands. While it is still waiting for
 * the owner, the call is held until they answer or `waitMs` pass.
 */
export async function checkPermission(
  scope: PermissionScope,
  id: string,
  { signal, waitMs }: { signal?: AbortSignal; waitMs?: number } = {},
): Promise<CallToolResult> {
  const look = () =>
    getPermissionView(scope.ctx, id, {
      publicUrl: scope.publicUrl,
      tokenId: scope.tokenId,
    })
  const first = await look()

  if (!first) {
    return text("There is no permission request with that id.", true)
  }

  // A request that is running finishes in a moment: wait for that too.
  const settled = (view: PermissionView | null) =>
    view && view.status !== "pending" && view.status !== "running" ? view : null
  const view =
    settled(first) ??
    (await waitForOwner(async () => settled(await look()), {
      signal,
      ms: waitMs,
    })) ??
    (await look()) ??
    first

  if (view.status === "pending") {
    return text(
      `Still waiting for the owner:\n\n${summaryText(view)}\n\nThey answer at ${view.url} until ${view.expiresAt.toISOString()}. If they are still on it, call check_permission again to keep waiting; otherwise stop here, and check again when they say they have answered.`,
    )
  }

  const outcome = outcomeOf(view)
  const said =
    outcome.content[0]?.type === "text" ? outcome.content[0].text : ""

  // Allowed, but the server it added still needs signing in to.
  if (view.connect) {
    const server = await getServer(scope.ctx, view.connect.serverId)
    const connect = connectResult(server, scope.publicUrl, {
      lead: "Not connected yet",
    })
    const next =
      connect.content[0]?.type === "text" ? connect.content[0].text : ""

    return { ...connect, content: [{ type: "text", text: `${said}\n${next}` }] }
  }

  // An OAuth server it added has been signed in to since: the outcome still
  // says it needs connecting, so say where it is now.
  const added =
    view.kind === "register" && view.serverId
      ? await db().mcpServer.findFirst({
          where: { id: view.serverId, vaultId: scope.ctx.vaultId },
          include: { _count: { select: { tools: true } } },
        })
      : null

  if (added?.authType === "oauth") {
    const server: ServerState = {
      id: added.id,
      name: added.name,
      slug: added.slug,
      connected: !needsConnecting(added),
      status: added.status,
      toolCount: added._count.tools,
    }

    return {
      content: [
        {
          type: "text",
          text: `${said}\nIt is connected now, with ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}.`,
        },
      ],
      structuredContent: { kind: "done", server },
    }
  }

  return outcome
}

/**
 * A pending proposal of tool levels, with what its page shows: the tools
 * the token reaches and the proposed levels still about them. Null when
 * there is no such request or it is no longer open.
 */
export async function getAccessProposal(
  ctx: VaultContext,
  id: string,
): Promise<
  (Awaited<ReturnType<typeof accessReview>> & { tokenId: string }) | null
> {
  const row = await loadRow({ id, vaultId: ctx.vaultId })

  if (!row || row.kind !== "access" || !isOpen(row)) {
    return null
  }

  const { levels } = readArgs(ctx, row) as AccessAsk["input"]

  return {
    tokenId: row.tokenId,
    ...(await accessReview(ctx, row.tokenId, levels)),
  }
}

/**
 * The owner saved a proposal of tool levels on its page: writes the levels
 * they chose there (the proposal, or what they made of it), once. Only the
 * signed-in owner's page calls this; nothing an assistant sends reaches it.
 * Throws when nothing was saved.
 */
export async function applyAccessRequest(
  ctx: VaultContext,
  id: string,
  levels: unknown,
  { publicUrl }: { publicUrl: string },
): Promise<CallToolResult> {
  const row = await loadRow({ id, vaultId: ctx.vaultId })

  if (!row || row.kind !== "access") {
    throw notFound("That proposal")
  }

  if (!isOpen(row)) {
    throw new PcpError(
      "state",
      "This proposal was already answered or has expired. Nothing was saved.",
    )
  }

  if (!tokenIsLive(row.token)) {
    const message =
      "The token that asked is no longer valid, so no tool's level changed."
    await finishUnrun(ctx, row, publicUrl, message)
    throw new PcpError("state", message)
  }

  // Refused before the row is claimed, so the owner can fix it and save.
  const chosen = await checkAccessLevels(ctx, row.tokenId, levels)
  const claimed = await claim(row.id)

  if (claimed.count !== 1) {
    throw new PcpError(
      "state",
      "This proposal was answered meanwhile. Nothing was saved.",
    )
  }

  let outcome: { failed: boolean; text: string }

  try {
    await writeAccessLevels(ctx, row.tokenId, chosen)
    const { levels: proposed } = readArgs(ctx, row) as {
      levels: AccessLevel[]
    }
    outcome = { failed: false, text: describeSavedAccess(proposed, chosen) }
  } catch (error) {
    if (!isPcpError(error)) {
      console.error("[permissions] saving tool levels failed", {
        id: row.id,
        error,
      })
    }

    outcome = {
      failed: true,
      text: isPcpError(error)
        ? error.message
        : "Something went wrong inside PCP.",
    }
  }

  await db().permissionRequest.update({
    where: { id: row.id },
    data: {
      status: outcome.failed ? "failed" : "executed",
      resultIsError: outcome.failed,
      resultCiphertext: asBytes(
        encryptString(ctx.dek, outcome.text, `${aad(row.id)}:result`),
      ),
    },
  })

  return text(outcome.text, outcome.failed)
}

/** Deletes requests a week past their expiry, answered or not. */
export async function prunePermissionRequests(
  now = new Date(),
): Promise<number> {
  const { count } = await db().permissionRequest.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - PERMISSION_KEEP_MS) } },
  })

  return count
}
