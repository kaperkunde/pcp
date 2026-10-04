import {
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
} from "@modelcontextprotocol/server"

import type {
  McpServer,
  McpTool,
  PermissionRequest,
} from "@/lib/generated/prisma/client"

import type { SyncResult } from "./catalogue"
import type {
  PermissionDecision,
  PermissionKind,
  PermissionTier,
} from "./constants"
import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import {
  createApprovedEndpoint,
  type EndpointRegistration,
} from "./endpoint-admin"
import { isPcpError } from "./errors"
import { newId } from "./ids"
import {
  decideMemoryAsk,
  describeMemoryAsk,
  type MemoryAsk,
  type MemoryDecision,
} from "./memories"
import {
  connectPanel,
  connectResult,
  panelResult,
  type ConnectPanel,
  type PanelContent,
  type PermissionPanel,
} from "./panel"
import {
  choosePermissionTier,
  decisionSchema,
  decisionsFor,
  isOpen,
  parseDecision,
  PERMISSION_KEEP_MS,
  PERMISSION_TTL_MS,
  previewArgs,
  requestHash,
  storedResultText,
  summaryText,
  type PermissionStatus,
  type PermissionVia,
} from "./permission-rules"
import { summarize } from "./search"
import { createServer, getServer, type ServerInput } from "./servers"
import { writeToolAccess } from "./tool-access"
import { pageResult, resultKeeper, resultNotices } from "./tool-results"
import { callServerTool, needsConnecting, syncServerTools } from "./upstream"

/**
 * The owner's say before an assistant's call runs. A call to a tool the
 * token may only "ask" about, and every new server an assistant wants to
 * add, becomes a pending request row; the owner answers wherever their
 * client lets them (see choosePermissionTier): the PCP panel in the
 * conversation, the client's own prompt, or /permissions/<id> in PCP.
 * Whichever way, decidePermission() runs the call, once.
 *
 * Nothing here trusts the assistant: a call runs when the client returns
 * the owner's answer to a prompt this server issued (bound to the row by
 * requestState and the hash of the call), when the panel's app-only tool
 * reports a click, or when the signed-in owner answers on the page.
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
  /** How the token lets PCP ask the owner, in trying order. */
  permissionTiers: readonly PermissionTier[]
}

/** The parts of an MCP request the permission step reads. */
export type ToolRequest = {
  /**
   * What the client says it can show. Sent with every request since
   * protocol revision 2026-07-28; undefined on older requests, which
   * declared it once at an initialize a stateless server never sees.
   */
  clientCapabilities?: ClientCapabilities
  /** Answers to a previous input_required round (a prompt this server sent). */
  inputResponses?: Record<string, unknown>
  /** The opaque state a previous input_required round handed out: a row id. */
  requestState?: string
}

/**
 * A new server as an assistant asked for it; never a secret's value. With
 * `endpoint` it is an API from OpenAPI text, and `url` is its base URL.
 */
export type RegisterArgs = ServerInput & {
  secretName?: string | null
  endpoint?: EndpointRegistration
}

export type PermissionAsk =
  | {
      kind: "call"
      server: McpServer
      /** Only the name is read: the gateway keeps a slimmer tool than the row. */
      tool: Pick<McpTool, "name">
      args: Record<string, unknown>
    }
  | { kind: "register"; input: RegisterArgs }
  | MemoryAsk

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
  url: string
  createdAt: Date
  expiresAt: Date
  outcome: string | null
  outcomeIsError: boolean
  decisions: Array<{ value: PermissionDecision; label: string }>
  /** Set once an allowed request left an OAuth server needing connecting. */
  connect: ConnectPanel | null
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
 * One call to an upstream tool, for the token that asked. An answer too
 * long for one piece is kept for that token and handed over a page at a
 * time (lib/core/tool-results.ts). An OAuth server that is not connected
 * (or whose sign-in expired) answers with the connect panel instead of an
 * error.
 */
export async function runCall(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  { publicUrl, tokenId }: { publicUrl: string; tokenId: string },
  executor: PermissionExecutor = defaultExecutor,
): Promise<CallToolResult> {
  if (needsConnecting(server)) {
    return connectResult(server, publicUrl)
  }

  try {
    const keep = resultKeeper(ctx, tokenId)

    return await pageResult(
      await executor.callTool(ctx, server, toolName, args, { publicUrl }),
      keep,
      { serverId: server.id, toolName },
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
      return { target: `${ask.server.id}/${ask.tool.name}`, args: ask.args }
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
async function summarizeRow(
  ctx: VaultContext,
  row: Row,
): Promise<{ title: string; lines: string[]; warning: string | null }> {
  const args = readArgs(ctx, row)
  const asker = `Asked by the token "${row.token.name}"`

  if (isMemoryKind(row.kind)) {
    const asked = describeMemoryAsk({
      kind: row.kind,
      input: args,
    } as MemoryAsk)

    return { ...asked, lines: [...asked.lines, asker] }
  }

  if (row.kind === "register") {
    const input = args as RegisterArgs
    const auth =
      input.authType === "header"
        ? `Authentication: sends your secret "${input.secretName ?? "?"}" in the ${input.authHeaderName || "Authorization"} header`
        : input.authType === "oauth"
          ? `Authentication: OAuth; you sign in when you connect it${input.oauthScope ? ` (scope ${input.oauthScope})` : ""}`
          : "Authentication: none"
    const warning =
      input.authType === "header"
        ? `PCP will send the secret "${input.secretName ?? "?"}" to this address with every call. Only add it if you trust the address.`
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
  const summary = await summarizeRow(ctx, row)
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
    url: permissionUrl(publicUrl, row.id),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    outcome: readResult(ctx, row),
    outcomeIsError: row.resultIsError,
    decisions: decisionsFor(kind),
    connect:
      finished && row.server && needsConnecting(row.server)
        ? connectPanel(row.server, publicUrl)
        : null,
  }
}

export function permissionPanel(view: PermissionView): PermissionPanel {
  return {
    id: view.id,
    kind: view.kind,
    status: "pending",
    title: view.title,
    lines: view.lines,
    warning: view.warning,
    url: view.url,
    expires_at: view.expiresAt.toISOString(),
    decisions: view.decisions,
  }
}

/** What the assistant is told about a request that is no longer pending. */
function outcomeOf(view: PermissionView): CallToolResult {
  // A memory's outcome says in full what the owner chose and what happened.
  if (isMemoryKind(view.kind) && view.outcome && view.status !== "running") {
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
        `Still waiting for the owner. They can answer at ${view.url} until ${view.expiresAt.toISOString()}.`,
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

function pendingText(
  view: PermissionView,
  tier: PermissionTier,
  toolShowsPanel: boolean,
): string {
  const where =
    tier === "app" && toolShowsPanel
      ? `Ask the owner to answer in the panel above, or at ${view.url}.`
      : tier === "app"
        ? `Call check_permission with id "${view.id}": it shows the owner a panel to answer in. Or ask them to open ${view.url}.`
        : `Ask the owner to open ${view.url} (signed in to PCP) and answer there.`

  return `Not done yet: this needs the owner's permission.\n\n${summaryText(view)}\n\n${where} It stays open until ${view.expiresAt.toISOString()}. Afterwards, call check_permission with id "${view.id}" for the result.`
}

/**
 * Asks the owner about a call or a new server, or picks up their answer
 * when the client comes back from a prompt this server issued.
 */
export async function withPermission(
  scope: PermissionScope,
  ask: PermissionAsk,
  request: ToolRequest,
  {
    toolShowsPanel = false,
    executor = defaultExecutor,
  }: { toolShowsPanel?: boolean; executor?: PermissionExecutor } = {},
): Promise<CallToolResult | InputRequiredResult> {
  if (typeof request.requestState === "string") {
    return resumeRound(scope, ask, request, request.requestState, executor)
  }

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
        serverId: ask.kind === "call" ? ask.server.id : null,
        toolName: toolNameOf(ask),
        argsCiphertext: asBytes(
          encryptString(scope.ctx.dek, JSON.stringify(args), aad(id)),
        ),
        argsHash,
        expiresAt: new Date(now.getTime() + PERMISSION_TTL_MS),
      },
    })
  }

  const row = await loadRow({ id, vaultId: scope.ctx.vaultId })
  const view = await toView(scope.ctx, row!, scope.publicUrl)
  const tier = choosePermissionTier(
    request.clientCapabilities,
    scope.permissionTiers,
  )

  switch (tier) {
    case "form":
      return inputRequired({
        inputRequests: {
          decision: inputRequired.elicit({
            message: `An assistant asked PCP for this:\n\n${summaryText(view)}`,
            requestedSchema: decisionSchema(view.kind),
          }),
        },
        requestState: view.id,
      })

    case "url":
      return inputRequired({
        inputRequests: {
          decision: inputRequired.elicitUrl({
            message: `Answer in PCP: ${view.title}`,
            url: view.url,
          }),
        },
        requestState: view.id,
      })

    default:
      // The panel and the plain link share one result: a panel reads
      // structuredContent, and the text carries the link for everyone else.
      return panelResult(
        pendingText(view, tier, toolShowsPanel),
        waitingContent(view, tier),
      )
  }
}

/**
 * What a panel shows while a request waits. Buttons only on the app tier:
 * anywhere else answer_permission refuses them, so a host that mounts the
 * panel anyway shows where to answer instead.
 */
function waitingContent(
  view: PermissionView,
  tier: PermissionTier,
): PanelContent {
  return tier === "app"
    ? { kind: "permission", permission: permissionPanel(view) }
    : { kind: "done", text: `Waiting for you. Answer in PCP: ${view.url}` }
}

/** The client came back from a form or URL prompt this server issued. */
async function resumeRound(
  scope: PermissionScope,
  ask: PermissionAsk,
  request: ToolRequest,
  id: string,
  executor: PermissionExecutor,
): Promise<CallToolResult> {
  const row = await db().permissionRequest.findFirst({
    where: { id, vaultId: scope.ctx.vaultId, tokenId: scope.tokenId },
    select: { id: true, argsHash: true, kind: true },
  })
  const { target, args } = describeAsk(ask)

  if (
    !row ||
    row.kind !== ask.kind ||
    row.argsHash !== requestHash(ask.kind, target, args)
  ) {
    return text(
      "That permission request belongs to a different call. Call the tool again to ask the owner anew.",
      true,
    )
  }

  const options = {
    via: "form" as const,
    publicUrl: scope.publicUrl,
    tokenId: scope.tokenId,
  }
  const answer = inputResponse(request.inputResponses, "decision")

  if (answer.kind === "elicit" && answer.action === "accept") {
    // Form mode carries the answer; URL mode only says the page was opened,
    // so its outcome is whatever the owner decided there.
    if (answer.content && "decision" in answer.content) {
      let decision: PermissionDecision

      try {
        decision = parseDecision(
          row.kind as PermissionKind,
          answer.content.decision,
        )
      } catch (error) {
        return text(isPcpError(error) ? error.message : "Unknown answer.", true)
      }

      return decidePermission(scope.ctx, row.id, decision, options, executor)
    }

    return outcomeFromRow(scope.ctx, row.id, scope.publicUrl)
  }

  if (answer.kind === "elicit") {
    return decidePermission(scope.ctx, row.id, "decline", options, executor)
  }

  return outcomeFromRow(scope.ctx, row.id, scope.publicUrl)
}

/**
 * The owner's answer, from the prompt, the panel or the page. "Always
 * allow" and "Block" also set the tool's level for the token; "Allow once"
 * and "Always allow" run the call, once, however many answers race for it.
 */
export async function decidePermission(
  ctx: VaultContext,
  id: string,
  decision: PermissionDecision,
  {
    via,
    publicUrl,
    tokenId,
  }: { via: PermissionVia; publicUrl: string; tokenId?: string },
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
      { via, publicUrl },
      "The token that asked is no longer valid, so nothing ran.",
    )
  }

  if (isMemoryKind(kind)) {
    return decideMemory(ctx, row, choice as MemoryDecision, {
      via,
      publicUrl,
    })
  }

  if (choice === "block" || choice === "decline") {
    if (choice === "block" && row.serverId) {
      await writeToolAccess(row.tokenId, row.serverId, row.toolName, "blocked")
    }

    return finishUnrun(
      ctx,
      row,
      { via, publicUrl },
      choice === "block"
        ? `The owner blocked ${toolLabel(row)} for this token, so nothing ran.`
        : "The owner said no, so nothing ran.",
    )
  }

  if (choice === "always" && row.serverId) {
    await writeToolAccess(row.tokenId, row.serverId, row.toolName, "allowed")
  }

  // One winner, however many clicks, panels and prompts race for it.
  const claimed = await db().permissionRequest.updateMany({
    where: { id: row.id, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "running", via, decidedAt: new Date() },
  })

  if (claimed.count !== 1) {
    return outcomeFromRow(ctx, row.id, publicUrl)
  }

  let result: CallToolResult

  try {
    result =
      kind === "call"
        ? await executeCall(ctx, row, publicUrl, executor)
        : await executeRegister(ctx, row, publicUrl, executor)
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

  const kindOfResult = (
    result.structuredContent as { kind?: string } | undefined
  )?.kind
  // A call that reached an unconnected server did not run; a new server that
  // now needs connecting was added, which is what the owner agreed to.
  const failed =
    result.isError === true || (kind === "call" && kindOfResult === "connect")
  const texts = result.content.flatMap((part) =>
    part.type === "text" ? [part.text] : [],
  )
  const stored = storedResultText(texts, undefined, resultNotices(texts))

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

  return runCall(
    ctx,
    row.server,
    row.toolName,
    readArgs(ctx, row),
    { publicUrl, tokenId: row.tokenId },
    executor,
  )
}

async function executeRegister(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
  executor: PermissionExecutor,
): Promise<CallToolResult> {
  const asked = readArgs(ctx, row) as RegisterArgs
  const created: { id: string; sync?: SyncResult } = asked.endpoint
    ? await createApprovedEndpoint(ctx, {
        name: asked.name,
        description: asked.description,
        url: asked.url,
        authType: asked.authType === "header" ? "header" : "none",
        authHeaderName: asked.authHeaderName,
        authValueTemplate: asked.authValueTemplate,
        authSecretId: asked.authSecretId,
        endpoint: asked.endpoint,
      })
    : await createServer(ctx, {
        name: asked.name,
        url: asked.url,
        description: asked.description,
        authType: asked.authType,
        authHeaderName: asked.authHeaderName,
        authValueTemplate: asked.authValueTemplate,
        authSecretId: asked.authSecretId,
        oauthScope: asked.oauthScope,
      })
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

  if (server.authType === "oauth") {
    return connectResult(server, publicUrl, { lead: added })
  }

  // An endpoint's tools were read from the text the owner just approved.
  const sync =
    created.sync ?? (await executor.syncTools(ctx, server, { publicUrl }))

  if (sync.status !== "ok") {
    return text(
      `${added}, but its tools could not be read yet: ${sync.message}`,
    )
  }

  return text(
    `${added} with ${sync.toolCount} tool${sync.toolCount === 1 ? "" : "s"}.${created.sync && sync.message ? ` ${sync.message}` : ""} They ask the owner the first time they are used; search_tools finds them.`,
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
  { via, publicUrl }: { via: PermissionVia; publicUrl: string },
): Promise<CallToolResult> {
  const claimed = await db().permissionRequest.updateMany({
    where: { id: row.id, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "running", via, decidedAt: new Date() },
  })

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

/** Closes a request without running it. */
async function finishUnrun(
  ctx: VaultContext,
  row: Row,
  { via, publicUrl }: { via: PermissionVia; publicUrl: string },
  message: string,
): Promise<CallToolResult> {
  const updated = await db().permissionRequest.updateMany({
    where: { id: row.id, status: "pending" },
    data: {
      status: "declined",
      via,
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

/** check_permission: where a request stands, with the panel while pending. */
export async function checkPermission(
  scope: PermissionScope,
  id: string,
  request: ToolRequest = {},
): Promise<CallToolResult> {
  const view = await getPermissionView(scope.ctx, id, {
    publicUrl: scope.publicUrl,
    tokenId: scope.tokenId,
  })

  if (!view) {
    return text("There is no permission request with that id.", true)
  }

  if (view.status === "pending") {
    const tier = choosePermissionTier(
      request.clientCapabilities,
      scope.permissionTiers,
    )
    const where =
      tier === "app" ? `in the panel, or at ${view.url}` : `at ${view.url}`

    return panelResult(
      `Still waiting for the owner:\n\n${summaryText(view)}\n\nThey can answer ${where} until ${view.expiresAt.toISOString()}.`,
      waitingContent(view, tier),
    )
  }

  const outcome = outcomeOf(view)
  const said =
    outcome.content[0]?.type === "text" ? outcome.content[0].text : ""

  return panelResult(
    said,
    { kind: "done", text: said, isError: outcome.isError === true },
    { isError: outcome.isError === true },
  )
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
