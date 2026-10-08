import type { CallToolResult } from "@modelcontextprotocol/server"

import type {
  McpServer,
  McpTool,
  PermissionRequest,
} from "@/lib/generated/prisma/client"

import {
  answerValue,
  readFields,
  shapeAnswerKeeping,
  type AnswerShape,
} from "./answers"
import {
  accessReview,
  checkAccessLevels,
  describeAccessAsk,
  describeSavedAccess,
  listAccessLevels,
  writeAccessLevels,
  type AccessAsk,
  type AccessLevel,
} from "./access-requests"
import { allowSiteFor, allowToolFor, parseAllowForMinutes } from "./allowances"
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
import { MAX_CALLS_PER_RUN } from "./code/limits"
import { invalid, isPcpError, notFound, PcpError } from "./errors"
import { fetchWeb } from "./fetch/fetch"
import type { FetchArgs } from "./fetch/request"
import { newId } from "./ids"
import { createMailAccount } from "./mail/accounts"
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
  linkLastText,
  type ConnectLinks,
  type ServerState,
} from "./connect"
import { waitForOwner } from "./owner-wait"
import {
  argsInFull,
  canonicalJson,
  decisionsFor,
  isOpen,
  PERMISSION_KEEP_MS,
  PERMISSION_TTL_MS,
  previewArgs,
  requestHash,
  storedResultText,
  summaryText,
  visible,
  type PermissionStatus,
  type ShownText,
} from "./permission-rules"
import type { MailRegistration } from "./register-rules"
import { summarize } from "./search"
import {
  createSecretNamedAfter,
  deleteSecret,
  findTextSecretByName,
  validateSecretValue,
} from "./secrets"
import { oauthRedirectUrl } from "./oauth-client"
import {
  createServer,
  getServer,
  type ExtraAuthHeader,
  type ServerInput,
} from "./servers"
import { writeToolAccess } from "./tool-access"
import { noteOwnerAsked } from "./request-log"
import { collectHandleIds } from "./result-handles"
import {
  describeResults,
  keepWholeAnswer,
  resultKeepers,
  resultNotices,
  resultOpener,
} from "./tool-results"
import { finishHandover, performNavigate } from "./browser/call"
import { RUN_COMMAND, stdinAsText } from "./ssh/tools"
import { describeBrowseAsk, describeHandoverAsk } from "./browser/describe"
import type { fetchThroughBrowser } from "./browser/solve"
import {
  isOwnerNeeded,
  type BrowseAsk,
  type HandoverAsk,
} from "./browser/types"
import { resourceLimits } from "./resources/state"
import { callServerTool, needsConnecting, syncServerTools } from "./upstream"
import {
  applyWrapperChange,
  type WrapperChangeAsk,
  type WrapperShown,
} from "./wrappers/admin"
import { readWrapperOperation } from "./wrappers/definition"
import type { SecretGrant } from "./wrappers/placeholders"
import {
  describeFetchAsk,
  privateAllowedFor,
  fetchHostOf,
  runFetch,
  writeSiteAccess,
} from "./web-fetch"

/**
 * The owner's say before an assistant's call runs. A call to a tool the
 * token may only "ask" about, every new server an assistant wants to add,
 * and every change to a shared memory becomes a pending request row. The
 * assistant is handed a link to /permissions/<id>, where the signed-in
 * owner answers; decidePermission() runs the call, once. Nothing here
 * trusts the assistant: only the owner's answer on that page runs anything.
 *
 * The assistant ends its reply with the link and calls check_permission
 * once the owner says they have answered; it holds the call while they are
 * still on it (lib/core/owner-wait.ts). The link has to come last: Claude's
 * apps fold the text written before a tool call into the tool's row and
 * show a summary of their own, so a link followed by check_permission in
 * the same reply was often never seen. Prompts in the client (elicitation)
 * and PCP's own panel (MCP Apps) were tried first and dropped: Claude's
 * apps stalled on prompts, and showed a panel they rebuilt with its first
 * question again, unable to ask PCP for the answer.
 *
 * An answer can also settle the tool for the calls after it ("Always
 * allow", "Block"), and for a web request the site ("Always allow this
 * site", "Block this site"), or let them go ahead for a while ("Allow for",
 * lib/core/allowances.ts) without changing a level.
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
export type RegisterArgs = Omit<ServerInput, "authExtraHeaders"> & {
  secretName?: string | null
  /** basic: the user name the secret (the password) goes with. */
  authUsername?: string | null
  /** Further headers, each with its stored secret's name for the owner. */
  authExtraHeaders?: Array<ExtraAuthHeader & { secretName: string }>
  newSecretName?: string | null
  /**
   * The new secret may be left empty: an OAuth client's secret, for a client
   * that has none. With OAuth the secret is the client's, sent only to the
   * token address; with a header it is sent with every call.
   */
  newSecretOptional?: boolean
  endpoint?: EndpointRegistration
  /** A mail account (JMAP or IMAP) rather than an MCP server or an API. */
  mail?: MailRegistration
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
  | { kind: "wrapper_change"; input: WrapperChangeAsk }
  | MemoryAsk
  | AccessAsk
  | { kind: "fetch"; input: FetchArgs }
  | { kind: "browse"; input: BrowseAsk }
  | { kind: "browser_handover"; input: HandoverAsk }

/** Runs what the owner allowed. Tests swap in a stub. */
export type PermissionExecutor = {
  callTool: typeof callServerTool
  syncTools: typeof syncServerTools
  /** web_fetch's request; the real one when left out. */
  fetchWeb?: typeof fetchWeb
  /** web_fetch's read through the browser past a site's check; the real one when left out. */
  solveWeb?: typeof fetchThroughBrowser
  /** The browser opening a site the owner allowed; the real one when left out. */
  browse?: typeof performNavigate
}

export const defaultExecutor: PermissionExecutor = {
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
  /** The server's kind, for the page's note on what allowing does. */
  serverKind: string | null
  tool: string
  title: string
  lines: string[]
  warning: string | null
  /**
   * Everything the request carries, for the page to fold under the lines
   * when they cut it short or wrote out what is in it; null when they say
   * it all.
   */
  full: ShownText[] | null
  /** A memory request's memory, for the page to show its text first. */
  memory: MemoryShown | null
  /** A wrapper request's tools and secrets, for the page to show in full. */
  wrapper: WrapperShown | null
  /** The browser tab a request is about, for the page to show it live. */
  browserTabId: string | null
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
    /** Set when it is the password for this user name (basic authentication). */
    login: string | null
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
 * the parts at `keep`, files and texts too long to read kept as results and
 * shown as handles, and never more than it should read. When shaping had to leave something
 * out, the whole answer is kept for the token that asked and the assistant
 * is told how to read it (lib/core/tool-results.ts). An OAuth server that is
 * not connected (or whose sign-in expired) answers with the link to connect
 * it instead of an error.
 */
export async function runCall(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    publicUrl,
    tokenId,
    fields,
    decode,
    keep,
    ownerAllowed = false,
    executor = defaultExecutor,
  }: {
    publicUrl: string
    /** The token the call is made for: the one that may read a kept answer. */
    tokenId: string
    /** The owner allowed this very call, its arguments shown to them. */
    ownerAllowed?: boolean
    executor?: PermissionExecutor
  } & AnswerShape,
): Promise<CallToolResult> {
  if (needsConnecting(server)) {
    return connectResult(server, publicUrl)
  }

  try {
    const keepers = resultKeepers(ctx, tokenId)
    const context = { serverId: server.id, toolName }
    const answer = await executor.callTool(ctx, server, toolName, args, {
      publicUrl,
      tokenId,
      keep: keepers.text,
      keepBytes: keepers.bytes,
      open: resultOpener(ctx, tokenId),
    })
    const { shown, whole } = await shapeAnswerKeeping(
      answer,
      { fields, decode, keep },
      {
        text: (input) => keepers.text({ ...input, ...context }),
        bytes: (input) => keepers.bytes({ ...input, ...context }),
      },
      { wholeMax: resourceLimits().textChars, links: true },
    )

    return await keepWholeAnswer(
      { raw: answer, shown, whole },
      keepers.text,
      context,
    )
  } catch (error) {
    // A site the owner just saw: a site is asked about only for the address
    // in the call's arguments, so when they allowed the call, they allowed
    // it for this tab. Not when the arguments held a kept result: the owner
    // saw its name, not the address in it, so the site is asked about.
    if (
      ownerAllowed &&
      isOwnerNeeded(error) &&
      error.ask.kind === "browse" &&
      collectHandleIds(args).length === 0
    ) {
      const { tabId, url } = error.ask.input

      return (executor.browse ?? performNavigate)(
        { ctx, tokenId, publicUrl, serverId: server.id },
        { tabId, url },
        { allowedByOwner: true },
      )
    }

    const owner = await ownerFirst(error, { ctx, tokenId, publicUrl, server })

    if (owner) {
      return owner
    }

    throw error
  }
}

/**
 * What the owner has to do before a call that failed this way can run, as
 * the result that hands them the link; null for any other failure.
 */
async function ownerFirst(
  error: unknown,
  { ctx, tokenId, publicUrl, server }: PermissionScope & { server: McpServer },
): Promise<CallToolResult | null> {
  // The browser needs the owner first: a site to allow, or a tab handed
  // over. Asked like any other request.
  if (isOwnerNeeded(error)) {
    return withPermission({ ctx, tokenId, publicUrl }, error.ask)
  }

  if (
    isPcpError(error) &&
    error.code === "unauthorized" &&
    server.authType === "oauth"
  ) {
    return connectResult(server, publicUrl)
  }

  return null
}

/** What one call of a program run by run_code came to. */
export type CodeCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string }
  /** The owner has to act first: the result with their link. */
  | { owner: CallToolResult }

/**
 * One call a program makes (lib/core/code/run.ts), through the same
 * upstream path as runCall, with the answer handed to the program as a
 * value (answers.ts answerValue) rather than shaped for an assistant to
 * read. An OAuth server to connect, or a browser site to allow, comes back
 * as `owner`: the run stops there and the assistant hands over the link.
 * What PCP refused, and what the tool answered as an error, are errors the
 * program sees.
 */
export async function runCodeCall(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    publicUrl,
    tokenId,
    fields,
    decode,
    keep,
    max,
    secrets,
    executor = defaultExecutor,
  }: {
    publicUrl: string
    tokenId: string
    /** The most characters of JSON the program is handed. */
    max: number
    /** A wrapper's call: where the owner allowed its secrets to go. */
    secrets?: SecretGrant
    executor?: PermissionExecutor
  } & AnswerShape,
): Promise<CodeCallOutcome> {
  if (needsConnecting(server)) {
    return { owner: connectResult(server, publicUrl) }
  }

  try {
    const keepers = resultKeepers(ctx, tokenId)
    const context = { serverId: server.id, toolName }
    const answer = await executor.callTool(ctx, server, toolName, args, {
      publicUrl,
      tokenId,
      keep: keepers.text,
      keepBytes: keepers.bytes,
      open: resultOpener(ctx, tokenId),
      ...(secrets ? { secrets } : {}),
    })

    return await answerValue(
      answer,
      { fields, decode, keep },
      {
        text: (input) => keepers.text({ ...input, ...context }),
        bytes: (input) => keepers.bytes({ ...input, ...context }),
      },
      { max },
    )
  } catch (error) {
    const owner = await ownerFirst(error, { ctx, tokenId, publicUrl, server })

    if (owner) {
      return { owner }
    }

    if (isPcpError(error)) {
      return { ok: false, error: error.message }
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
      // The same call asking for other fields, or to decode or keep other
      // paths, is another request.
      return {
        target: `${ask.server.id}/${ask.tool.name}${ask.fields ? `\n${canonicalJson(ask.fields)}` : ""}${ask.decode ? `\ndecode ${canonicalJson(ask.decode)}` : ""}${ask.keep ? `\nkeep ${canonicalJson(ask.keep)}` : ""}`,
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
    case "wrapper_change":
      return {
        target: `wrapper:${ask.input.serverId ?? ask.input.name}`,
        args: ask.input as Record<string, unknown>,
      }
    case "fetch":
      return {
        target: `fetch:${ask.input.method} ${ask.input.url}`,
        args: ask.input as Record<string, unknown>,
      }
    case "browse":
      return {
        target: `browse:${ask.input.tabId ?? "new"} ${ask.input.url}`,
        args: ask.input as Record<string, unknown>,
      }
    case "browser_handover":
      return {
        target: `handover:${ask.input.tabId}`,
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
    case "wrapper_change":
      return `${ask.input.action}_wrapper`
    case "fetch":
      return "web_fetch"
    case "browse":
      return ask.input.toolName
    case "browser_handover":
      return "hand_over"
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
      : input.mail
        ? [
            "Sign-in: PCP finds where the mail server signs you in when you connect it, and registers itself there if the server allows it; otherwise its page asks you for an OAuth client",
          ]
        : input.endpoint
          ? [
              "Client: none given. When you connect it, PCP registers itself with the provider if the provider allows that; otherwise its page asks you for an OAuth client",
            ]
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
  full?: ShownText[] | null
  memory?: MemoryShown
  wrapper?: WrapperShown
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

  if (row.kind === "wrapper_change") {
    const { shown } = args as WrapperChangeAsk

    return {
      title: shown.title,
      lines: [...shown.lines, asker],
      warning: shown.warning,
      wrapper: shown,
    }
  }

  if (row.kind === "browse") {
    const asked = describeBrowseAsk(args as BrowseAsk, {
      privateAllowed: await privateAllowedFor(ctx.vaultId, row.tokenId),
    })

    return { ...asked, lines: [...asked.lines, asker] }
  }

  if (row.kind === "browser_handover") {
    const asked = describeHandoverAsk(args as HandoverAsk)

    return { ...asked, lines: [...asked.lines, asker] }
  }

  if (row.kind === "fetch") {
    const asked = describeFetchAsk(args as FetchArgs, {
      privateAllowed: await privateAllowedFor(ctx.vaultId, row.tokenId),
    })

    return { ...asked, lines: [...asked.lines, asker] }
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
    const extras = input.authExtraHeaders ?? []
    // A credential in several parts: every secret, and the header it goes in.
    const andExtras = extras
      .map(
        (extra) =>
          `, and ${input.newSecretName ? "your secret " : ""}"${extra.secretName}" in the ${extra.headerName} header`,
      )
      .join("")
    const secrets = [
      input.secretName ?? "?",
      ...extras.map((e) => e.secretName),
    ]
      .map((name) => `"${name}"`)
      .join(" and ")
    const login = input.authUsername ?? "?"
    const mailAuth = Boolean(input.mail)
    const auth =
      input.authType === "basic" && input.newSecretName
        ? mailAuth
          ? `Authentication: user name and password; the password is saved as a new secret "${input.newSecretName}", and you enter it here when you agree`
          : `Authentication: sends a new secret, saved as "${input.newSecretName}", as the password for ${login} (HTTP Basic); you enter its value here when you agree`
        : input.authType === "basic"
          ? mailAuth
            ? `Authentication: user name and your secret "${input.secretName ?? "?"}" as the password`
            : `Authentication: sends your secret "${input.secretName ?? "?"}" as the password for ${login} (HTTP Basic)`
          : input.authType === "header" && mailAuth
            ? input.newSecretName
              ? `Authentication: a bearer token, saved as a new secret "${input.newSecretName}"; you enter it here when you agree`
              : `Authentication: your secret "${input.secretName ?? "?"}" as a bearer token`
            : input.authType === "header" && input.newSecretName
              ? `Authentication: sends a new secret, saved as "${input.newSecretName}", in the ${input.authHeaderName || "Authorization"} header${andExtras}; you enter its value here when you agree`
              : input.authType === "header"
                ? `Authentication: sends your secret "${input.secretName ?? "?"}" in the ${input.authHeaderName || "Authorization"} header${andExtras}`
                : input.authType === "oauth"
                  ? oauthLines[0]!
                  : "Authentication: none"
    const where = mailAuth ? "this mail server" : "this address"
    const warning =
      input.authType === "basic"
        ? `PCP will send the user name ${login} and the secret "${input.secretName ?? "?"}" to ${where} with every call. Only add it if you trust the address.`
        : input.authType === "header"
          ? `PCP will send the ${extras.length > 0 ? "secrets" : "secret"} ${secrets} to ${where} with every call. Only add it if you trust the address.`
          : input.authType === "oauth" && (input.endpoint || input.mail)
            ? `PCP will send your OAuth token for this account to ${where} with every call. Only add it if you trust the address${input.endpoint ? " and the sign-in addresses" : ""}.`
            : null

    if (input.mail) {
      const { protocol, smtpUrl, readOnly, mailFrom, checked, privateAddress } =
        input.mail
      const jmap = protocol === "jmap"

      return {
        title: `Add the mail account ${input.name}?`,
        lines: [
          jmap
            ? "Protocol: JMAP"
            : smtpUrl
              ? "Protocol: IMAP, sending through SMTP"
              : "Protocol: IMAP (it cannot send: no SMTP server was named)",
          jmap ? `Session URL: ${input.url}` : `IMAP server: ${input.url}`,
          ...(jmap && input.url.startsWith("http:")
            ? [
                "Not encrypted: the session URL starts with http://, so your sign-in travels unprotected across your network. Only agree if you trust every device on it.",
              ]
            : []),
          ...(smtpUrl ? [`SMTP server: ${smtpUrl}`] : []),
          ...(checked ? [`Checked: ${checked}`] : []),
          ...(privateAddress
            ? [
                `${privateAddress} If you agree, PCP signs in there from your own network.`,
              ]
            : []),
          ...(input.authType === "basic" ? [`User name: ${login}`] : []),
          auth,
          ...oauthLines.slice(1),
          readOnly
            ? "Read-only: only the tools that read mail"
            : "Can change things: its tools may send as you where the server allows it, move and flag mail, and delete into the Trash (never for good)",
          ...(mailFrom ? [`From address: ${mailFrom}`] : []),
          ...(input.description ? [`Description: ${input.description}`] : []),
          asker,
        ],
        warning,
      }
    }

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
  // Standard input sent as base64 is read as the text it is, when it is.
  const stdin =
    row.server?.kind === "ssh" && row.toolName === RUN_COMMAND
      ? stdinAsText(args)
      : null

  return {
    title: `Allow ${toolLabel(row)}?`,
    lines: [
      ...(row.server && row.server.kind !== "wrapper"
        ? [`Server: ${row.server.name} (${row.server.url})`]
        : []),
      ...(about ? [`What it does: ${about}`] : []),
      ...(row.server?.kind === "wrapper"
        ? await wrapperCallLines(ctx, row.server, tool?.operation ?? null)
        : []),
      asker,
      ...previewArgs(args),
      ...(await handleLines(ctx, row.tokenId, args)),
    ],
    warning: destructive
      ? "The server marks this tool as destructive: it can change or delete things for good."
      : null,
    full: argsInFull(
      args,
      stdin === null
        ? []
        : [{ label: "stdin_base64, decoded as text", text: visible(stdin) }],
    ),
  }
}

/**
 * What a call to a wrapper's tool does: the program the owner approved runs,
 * and may call these tools. One that would ask is not asked about again in
 * this run: the program calls it as often as it does, with the arguments it
 * works out, up to run_code's limit on calls in one run.
 */
async function wrapperCallLines(
  ctx: VaultContext,
  server: McpServer,
  operation: string | null,
): Promise<string[]> {
  const { calls } = readWrapperOperation(operation)
  const servers = await db().mcpServer.findMany({
    where: {
      vaultId: ctx.vaultId,
      id: { in: [...new Set(calls.map((call) => call.serverId))] },
    },
    select: { id: true, slug: true },
  })
  const slugs = new Map(servers.map((entry) => [entry.id, entry.slug]))

  return [
    `Runs the program you approved for the wrapper ${server.name}, which may call: ${calls.map((call) => `${slugs.get(call.serverId) ?? "(removed server)"}/${call.tool}`).join(", ")}`,
    `Allowing this call lets those calls run in it, as the token's levels allow. Any of them that would ask you first is not asked about again in this run: the program may call it as often as it does (at most ${MAX_CALLS_PER_RUN} calls in all), with whatever arguments it works out.`,
  ]
}

const COUNT = new Intl.NumberFormat("en-US")

/**
 * What each kept result a call's arguments name is, so the owner sees what
 * the call carries without its content: its name, type and size, which
 * server's tool kept it, and until when. An id the token no longer has is
 * said too, since the call would fail.
 */
async function handleLines(
  ctx: VaultContext,
  tokenId: string,
  args: Record<string, unknown>,
): Promise<string[]> {
  let ids: string[]

  try {
    ids = collectHandleIds(args, { loose: true })
  } catch {
    return []
  }

  const infos = await describeResults(ctx, tokenId, ids)
  const serverIds = infos.flatMap((info) =>
    info.found && info.serverId ? [info.serverId] : [],
  )
  const servers = serverIds.length
    ? await db().mcpServer.findMany({
        where: { id: { in: serverIds }, vaultId: ctx.vaultId },
        select: { id: true, slug: true },
      })
    : []
  const slugs = new Map(servers.map((server) => [server.id, server.slug]))

  return infos.map((info) => {
    if (!info.found) {
      return `Kept result ${info.id}: no longer available for this token; the call will fail`
    }

    const size =
      info.kind === "bytes"
        ? `${COUNT.format(info.length)} bytes`
        : `${COUNT.format(info.length)} characters`
    const from = info.serverId
      ? `${slugs.get(info.serverId) ?? "(removed server)"}/${info.toolName}`
      : info.toolName

    return `Kept result ${info.id}: ${info.name ?? "(unnamed)"}, ${info.mediaType}, ${size}, from ${from}, readable until ${info.expiresAt.toISOString()}`
  })
}

async function toView(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
): Promise<PermissionView> {
  const {
    memory = null,
    wrapper = null,
    full = null,
    ...summary
  } = await summarizeRow(ctx, row, publicUrl)
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
    serverKind: row.server?.kind ?? null,
    tool: row.toolName,
    ...summary,
    // Whatever made the lines, nothing in them hides from the owner.
    title: visible(summary.title),
    lines: summary.lines.map((line) => visible(line)),
    full,
    memory,
    wrapper,
    browserTabId: browserTabOf(ctx, row),
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

/** The tab a browser request is about, if it names one. */
function browserTabOf(
  ctx: VaultContext,
  row: PermissionRequest,
): string | null {
  if (row.kind !== "browse" && row.kind !== "browser_handover") {
    return null
  }

  const tabId = (readArgs(ctx, row) as { tabId?: unknown }).tabId
  return typeof tabId === "string" ? tabId : null
}

/** A secret the owner types in to agree to a new server, if there is one. */
function newSecretOf(
  ctx: VaultContext,
  row: PermissionRequest,
): {
  name: string
  optional: boolean
  clientId: string | null
  login: string | null
} | null {
  if (row.kind === "wrapper_change") {
    const { newSecret } = readArgs(ctx, row) as WrapperChangeAsk

    return newSecret
      ? { name: newSecret, optional: false, clientId: null, login: null }
      : null
  }

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
        login: args.authType === "basic" ? (args.authUsername ?? null) : null,
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
        `Still waiting for the owner. They can answer until ${view.expiresAt.toISOString()}. When they say they have, call check_permission with id "${view.id}" for the result.\n\n${linkLastText(view.url)}`,
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

function pendingText(view: PermissionView, detail?: string): string {
  if (view.kind === "access") {
    return `Not done yet: the owner saves tool levels themselves.\n\n${summaryText(view)}${detail ? `\n\n${detail}` : ""}\n\nThe owner opens the link below signed in to PCP. Your levels are filled in there and each change is marked; they can adjust any of them, and nothing changes until they save. When they say they have saved, call check_permission with id "${view.id}": it says what they saved (and waits a little if they are still on it). The request stays open until ${view.expiresAt.toISOString()}.\n\n${linkLastText(view.url)}`
  }

  const typed = view.secretToEnter
    ? view.secretToEnter.clientId
      ? ` They type the client secret of their OAuth client in there, if it has one; do not ask them for it here.`
      : view.secretToEnter.login
        ? ` They type the password for ${view.secretToEnter.login} in there, and it is saved as the secret "${view.secretToEnter.name}"; do not ask them for it here.`
        : ` They type the value of the secret "${view.secretToEnter.name}" in there; do not ask them for it here.`
    : ""

  return `Not done yet: this needs the owner's permission.\n\n${summaryText(view)}\n\nThe owner answers on the page at the link below, signed in to PCP.${typed} When they say they have answered, call check_permission with id "${view.id}" for the result (it waits a little if they are still on it). The request stays open until ${view.expiresAt.toISOString()}.\n\n${linkLastText(view.url)}`
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
            : ask.kind === "endpoint_change" ||
                ask.kind === "browse" ||
                ask.kind === "browser_handover"
              ? ask.input.serverId
              : null,
        toolName: toolNameOf(ask),
        fields:
          ask.kind === "call" && ask.fields ? JSON.stringify(ask.fields) : null,
        decode:
          ask.kind === "call" && ask.decode ? JSON.stringify(ask.decode) : null,
        keep: ask.kind === "call" && ask.keep ? JSON.stringify(ask.keep) : null,
        argsCiphertext: asBytes(
          encryptString(scope.ctx.dek, JSON.stringify(args), aad(id)),
        ),
        argsHash,
        expiresAt: new Date(now.getTime() + PERMISSION_TTL_MS),
      },
    })
  }

  noteOwnerAsked(id)

  const row = await loadRow({ id, vaultId: scope.ctx.vaultId })
  // The assistant hears which tools it named, to check its own patterns;
  // the page shows the owner the same levels in full.
  const detail =
    ask.kind === "access"
      ? listAccessLevels(
          ask.input.levels,
          await db().mcpServer.findMany({
            where: {
              vaultId: scope.ctx.vaultId,
              id: {
                in: [
                  ...new Set(ask.input.levels.map((level) => level.serverId)),
                ],
              },
            },
            select: { id: true, slug: true },
          }),
        )
      : undefined

  return text(
    pendingText(await toView(scope.ctx, row!, scope.publicUrl), detail),
  )
}

/**
 * The owner's answer on PCP's page. "Always allow" and "Block" also set the
 * tool's level for the token, and "Allow for" lets it run without asking
 * for `minutes`; every answer that agrees runs the call, once, however many
 * answers race for it.
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
    minutes,
  }: {
    publicUrl: string
    tokenId?: string
    /** The value of a new server's secret, typed in on PCP's page. */
    secretValue?: string
    /** A memory to share: read it in every conversation, ticked on the page. */
    always?: boolean
    /** "Allow for": how long, one of ALLOW_FOR_MINUTES. */
    minutes?: number
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
  // Only a tool call (for the tool) and a web request (for the site) have
  // "always", "allow_for" and "block": any other answer is about this one
  // request.
  const settles = kind === "call" || kind === "fetch" || kind === "browse"
  const choice: PermissionDecision = !settles
    ? decision === "always" || decision === "allow_for"
      ? "allow_once"
      : decision === "block"
        ? "decline"
        : decision
    : decision

  if (!decisionsFor(kind).some((offered) => offered.value === choice)) {
    return text("That is not one of the answers to this request.", true)
  }

  const allowFor = choice === "allow_for" ? parseAllowForMinutes(minutes) : null

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

  // The site a web request goes to, for the answers that settle it.
  const host =
    kind === "fetch"
      ? fetchHostOf(readArgs(ctx, row) as FetchArgs)
      : kind === "browse"
        ? fetchHostOf(readArgs(ctx, row) as BrowseAsk)
        : null

  if (choice === "block" || choice === "decline") {
    if (choice === "block" && host) {
      await writeSiteAccess(ctx.vaultId, row.tokenId, host, "blocked")
    } else if (choice === "block" && row.serverId) {
      await writeToolAccess(row.tokenId, row.serverId, row.toolName, "blocked")
    }

    if (kind === "browser_handover") {
      await finishHandover(ctx, (readArgs(ctx, row) as HandoverAsk).tabId)

      return finishUnrun(
        ctx,
        row,
        publicUrl,
        "The owner said not now, so they did not do it, and the tab is back with the browser tools.",
      )
    }

    return finishUnrun(
      ctx,
      row,
      publicUrl,
      choice === "block"
        ? `The owner blocked ${host ?? toolLabel(row)} for this token, so nothing ran.`
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

  if (choice === "always" && host) {
    await writeSiteAccess(ctx.vaultId, row.tokenId, host, "allowed")
  } else if (choice === "always" && row.serverId) {
    await writeToolAccess(row.tokenId, row.serverId, row.toolName, "allowed")
  } else if (allowFor && host) {
    await allowSiteFor(row.tokenId, host, allowFor)
  } else if (allowFor && row.serverId) {
    await allowToolFor(row.tokenId, row.serverId, row.toolName, allowFor)
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
          : kind === "wrapper_change"
            ? text(
                await applyWrapperChange(
                  ctx,
                  readArgs(ctx, row) as WrapperChangeAsk,
                  {
                    tokenId: row.tokenId,
                    ...(secretValue ? { secretValue } : {}),
                  },
                ),
              )
            : kind === "fetch"
              ? await executeFetch(ctx, row, publicUrl, executor)
              : kind === "browse"
                ? await executeBrowse(ctx, row, publicUrl, executor)
                : kind === "browser_handover"
                  ? await executeHandover(ctx, row)
                  : await executeRegister(
                      ctx,
                      row,
                      publicUrl,
                      executor,
                      secretValue,
                    )
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

  // A wrapper's tool runs its program for the token, the calls it would
  // ask about included: the owner allowed this call with its arguments.
  // Imported here: the runner calls back into this file.
  const wrappers =
    row.server.kind === "wrapper" ? await import("./wrappers/run") : null
  const wrapped = wrappers
    ? wrappers.withWrappers(executor, {
        ctx,
        tokenId: row.tokenId,
        publicUrl,
        serverIds: await wrappers.tokenServerIds(ctx, row.tokenId),
        approved: true,
      })
    : executor

  return runCall(ctx, row.server, row.toolName, readArgs(ctx, row), {
    publicUrl,
    tokenId: row.tokenId,
    fields: readStoredFields(row.fields),
    decode: readStoredFields(row.decode),
    keep: readStoredFields(row.keep),
    ownerAllowed: true,
    executor: wrapped,
  })
}

/**
 * A site the owner let the browser open: opened in the tab the assistant
 * asked for (or a new one), which may then open that site's pages while
 * it is open, if the browser is still there for the token.
 */
async function executeBrowse(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
  executor: PermissionExecutor,
): Promise<CallToolResult> {
  if (!row.server || row.server.kind !== "browser") {
    return text("The browser was removed from PCP, so nothing ran.", true)
  }

  if (!row.server.enabled) {
    return text("The browser is switched off in PCP, so nothing ran.", true)
  }

  const asked = readArgs(ctx, row) as BrowseAsk

  return (executor.browse ?? performNavigate)(
    { ctx, tokenId: row.tokenId, publicUrl, serverId: row.server.id },
    { tabId: asked.tabId, url: asked.url },
    { allowedByOwner: true },
  )
}

/** The owner is done in a tab an assistant handed them. */
async function executeHandover(
  ctx: VaultContext,
  row: Row,
): Promise<CallToolResult> {
  const { tabId } = readArgs(ctx, row) as HandoverAsk

  return (await finishHandover(ctx, tabId))
    ? text(
        `The owner is done in tab ${tabId}, and it is back with the browser tools. Take a snapshot to see where it is now.`,
      )
    : text(
        `Tab ${tabId} is gone (it was closed, or the browser has closed since), so there is nothing to go on from. Open the page again.`,
        true,
      )
}

/** A web request the owner allowed, if the token may still make one. */
async function executeFetch(
  ctx: VaultContext,
  row: Row,
  publicUrl: string,
  executor: PermissionExecutor,
): Promise<CallToolResult> {
  const token = await db().apiToken.findUnique({
    where: { id: row.tokenId },
    select: { webFetch: true },
  })

  if (!token?.webFetch) {
    return text(
      "This token can no longer fetch web pages (the owner turned it off), so nothing ran.",
      true,
    )
  }

  return runFetch(ctx, row.tokenId, readArgs(ctx, row) as FetchArgs, {
    publicUrl,
    fetcher: executor.fetchWeb ?? fetchWeb,
    solver: executor.solveWeb,
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
        : asked.authType === "basic"
          ? `The password for ${asked.authUsername ?? "?"} at ${asked.name}.`
          : asked.mail
            ? `Sent to ${asked.name} as a bearer token.`
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
          authUsername: asked.authUsername,
          authHeaderName: asked.authHeaderName,
          authValueTemplate: asked.authValueTemplate,
          authExtraHeaders: asked.authExtraHeaders,
          ...secretFields(asked, secret.id),
          endpoint: asked.endpoint,
        })
      : asked.mail
        ? await createMailAccount(ctx, {
            protocol: asked.mail.protocol,
            name: asked.name,
            description: asked.description,
            url: asked.url,
            smtpUrl: asked.mail.smtpUrl,
            readOnly: asked.mail.readOnly,
            mailFrom: asked.mail.mailFrom,
            authType: asked.authType as "basic" | "header" | "oauth",
            authUsername: asked.authUsername ?? null,
            ...secretFields(asked, secret.id),
          })
        : await createServer(ctx, {
            name: asked.name,
            url: asked.url,
            description: asked.description,
            authType: asked.authType,
            authHeaderName: asked.authHeaderName,
            authValueTemplate: asked.authValueTemplate,
            authExtraHeaders: asked.authExtraHeaders,
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

/** A request waiting for the owner, as the header's list shows it. */
export type PendingRequest = {
  id: string
  title: string
  tokenName: string
  createdAt: Date
}

/**
 * Every request in the vault still waiting for the owner, newest first: how
 * many there are, and the first `limit` of them with their titles.
 */
export async function listPendingRequests(
  ctx: VaultContext,
  publicUrl: string,
  { limit = 10 }: { limit?: number } = {},
): Promise<{ total: number; requests: PendingRequest[] }> {
  const now = new Date()
  // A revoked or expired token's requests can no longer be answered.
  const where = {
    vaultId: ctx.vaultId,
    status: "pending",
    expiresAt: { gt: now },
    token: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  }
  const [total, rows] = await Promise.all([
    db().permissionRequest.count({ where }),
    db().permissionRequest.findMany({
      where,
      include: ROW_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ])
  const requests = await Promise.all(
    rows.map(async (row) => {
      const { title } = await summarizeRow(ctx, row, publicUrl)

      return {
        id: row.id,
        title: visible(title),
        tokenName: row.token.name,
        createdAt: row.createdAt,
      }
    }),
  )

  return { total, requests }
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
      `Still waiting for the owner:\n\n${summaryText(view)}\n\nThey can answer until ${view.expiresAt.toISOString()}. Stop here, and call check_permission again when they say they have answered.\n\n${linkLastText(view.url)}`,
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
