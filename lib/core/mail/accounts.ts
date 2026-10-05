import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, isPcpError, PcpError } from "../errors"
import { newId } from "../ids"
import { errorToolResult, jsonToolResult } from "../json-result"
import { makeRedactor } from "../openapi/redact"
import {
  getServer,
  isMailKind,
  kindNoun,
  normalizeBasicAuth,
  normalizeHeaderAuth,
  normalizeNameAndDescription,
  normalizeOAuthClient,
  oauthTokensObsolete,
  secretColumns,
  setServerStatus,
  slugify,
  uniqueSlug,
  withNewSecret,
  type MailKind,
  type NewSecret,
  type OAuthClientInput,
} from "../servers"
import { deleteManagedSecret } from "../secrets"
import type { ResultKeeper } from "../tool-results"
import {
  formatMailServer,
  parseImapAddress,
  parseRecipient,
  parseSmtpAddress,
  validateSessionUrl,
} from "./addresses"
import {
  checkImapAccount,
  defaultImapDeps,
  openImapBackend,
  type ImapConfig,
  type ImapDeps,
} from "./imap"
import { fetchJmapSession, openJmapBackend } from "./jmap"
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_CHARS,
  MAX_FULL_BODY_BYTES,
} from "./limits"
import {
  mailToolSpec,
  mailTools,
  parseMailArgs,
  parseRecipients,
} from "./tools"
import {
  MailAuthError,
  MailRequestError,
  type MailBackend,
  type MailCredential,
  type SearchQuery,
} from "./types"

/**
 * Mail accounts: servers of kind "jmap" and "imap". The owner adds one in
 * PCP with the account's address and how to sign in; PCP then offers the
 * fixed mail tools (tools.ts) through the gateway like any server's.
 *
 * Secrets never come here: upstream.ts hands in a MailCredential with the
 * header or login already made, as it does for an API endpoint. Assistants
 * cannot add or change a mail account; only the owner can, in PCP.
 */

export type MailAccountInput = OAuthClientInput & {
  protocol: MailKind
  name: string
  description?: string
  /** jmap: the session URL. imap: the IMAP server. */
  url: string
  /** imap: the SMTP server; empty when the account does not send. */
  smtpUrl?: string | null
  readOnly: boolean
  /** jmap: basic, header (a bearer token) or oauth. imap: basic. */
  authType: "basic" | "header" | "oauth"
  authUsername?: string | null
  authSecretId?: string | null
  mailFrom?: string | null
}

const EMPTY_AUTH = {
  authUsername: null as string | null,
  authSecretId: null as string | null,
  authHeaderName: null as string | null,
  authValueTemplate: null as string | null,
  oauthClientId: null as string | null,
  oauthClientSecretId: null as string | null,
  oauthScope: null as string | null,
  oauthAuthorizeParams: null as string | null,
}

async function normalizeMailAccount(
  ctx: VaultContext,
  input: MailAccountInput,
) {
  const { name, description } = normalizeNameAndDescription(input)
  const imap = input.protocol === "imap"
  const url = imap
    ? formatMailServer("imap", parseImapAddress(input.url))
    : validateSessionUrl(input.url)
  const smtpUrl =
    imap && input.smtpUrl?.trim()
      ? formatMailServer("smtp", parseSmtpAddress(input.smtpUrl))
      : null
  const mailFrom = input.mailFrom?.trim()
    ? parseRecipient(input.mailFrom).email
    : null
  const auth = { ...EMPTY_AUTH }
  let newSecret: NewSecret | null = null

  if (imap && input.authType !== "basic") {
    throw invalid("An IMAP account signs in with a user name and password.")
  }

  switch (input.authType) {
    case "basic": {
      const basic = await normalizeBasicAuth(ctx, input, { name })
      auth.authUsername = basic.authUsername
      auth.authSecretId = basic.authSecretId
      newSecret = basic.newSecret
      break
    }
    case "header": {
      // A bearer token, the way JMAP servers take one.
      const header = await normalizeHeaderAuth(
        ctx,
        {
          authSecretId: input.authSecretId,
          authHeaderName: "Authorization",
          authValueTemplate: "Bearer {{secret}}",
        },
        { name },
      )
      auth.authSecretId = header.authSecretId
      auth.authHeaderName = header.authHeaderName
      auth.authValueTemplate = header.authValueTemplate
      newSecret = header.newSecret
      break
    }
    case "oauth": {
      const client = await normalizeOAuthClient(ctx, input, { name })
      auth.oauthClientId = client.oauthClientId
      auth.oauthClientSecretId = client.oauthClientSecretId
      auth.oauthScope = client.oauthScope
      auth.oauthAuthorizeParams = client.oauthAuthorizeParams
      newSecret = client.newSecret
      break
    }
    default:
      throw invalid("Choose how PCP signs in to the mail server.")
  }

  if (smtpUrl && !mailFrom && !(auth.authUsername ?? "").includes("@")) {
    throw invalid(
      "Enter the From address to send as: the user name is not an email address.",
    )
  }

  return {
    data: {
      name,
      description,
      url,
      smtpUrl,
      mailFrom,
      readOnly: input.readOnly,
      authType: input.authType,
      ...auth,
    },
    /** A client secret typed into the form, saved with the row. */
    newSecret,
  }
}

export async function createMailAccount(
  ctx: VaultContext,
  input: MailAccountInput,
): Promise<{ id: string }> {
  if (!isMailKind(input.protocol)) {
    throw invalid("Choose JMAP or IMAP.")
  }

  const { data, newSecret } = await normalizeMailAccount(ctx, input)
  const id = newId()
  const slug = await uniqueSlug(ctx.vaultId, slugify(data.name))

  await withNewSecret(ctx, newSecret, async (secretId) => {
    await db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        kind: input.protocol,
        slug,
        ...data,
        ...secretColumns(data, secretId),
      },
    })
  })

  return { id }
}

/** What reaching the account depends on; a change means checking it again. */
const CONNECTION_FIELDS = [
  "url",
  "smtpUrl",
  "authType",
  "authUsername",
  "authSecretId",
  "oauthClientId",
  "oauthClientSecretId",
  "oauthScope",
  "readOnly",
  "mailFrom",
] as const

/**
 * Saves an account's settings. `reconnect` says it should be checked again:
 * its address, sign-in or what it may do changed.
 */
export async function updateMailAccount(
  ctx: VaultContext,
  id: string,
  input: Omit<MailAccountInput, "protocol">,
): Promise<{ reconnect: boolean }> {
  const existing = await getServer(ctx, id)

  if (!isMailKind(existing.kind)) {
    throw new PcpError(
      "state",
      `This is ${kindNoun(existing.kind)}; change it in its own settings.`,
    )
  }

  const { data, newSecret } = await normalizeMailAccount(ctx, {
    ...input,
    protocol: existing.kind,
  })
  const dropTokens = oauthTokensObsolete(existing, data)
  const reconnect =
    newSecret !== null ||
    CONNECTION_FIELDS.some((key) => data[key] !== existing[key])

  await withNewSecret(ctx, newSecret, (secretId) =>
    db().mcpServer.update({
      where: { id },
      data: {
        ...data,
        ...secretColumns(data, secretId),
        // What the last session said belongs to the old address or sign-in.
        ...(reconnect
          ? {
              mailApiUrl: null,
              mailDownloadUrl: null,
              mailAccountId: null,
              mailSubmission: false,
            }
          : {}),
        ...(dropTokens
          ? { oauthTokensId: null, oauthConnectedAt: null, status: "unknown" }
          : {}),
      },
    }),
  )

  if (dropTokens && existing.oauthTokensId) {
    await deleteManagedSecret(ctx, existing.oauthTokensId)
  }

  return { reconnect }
}

function imapConfig(server: McpServer): ImapConfig {
  return {
    imap: parseImapAddress(server.url),
    smtp: server.smtpUrl ? parseSmtpAddress(server.smtpUrl) : null,
    from: server.mailFrom,
  }
}

function loginOf(server: McpServer, credential: MailCredential) {
  if (!credential.login) {
    throw new PcpError(
      "state",
      `${server.name} has no user name and password configured.`,
    )
  }

  return credential.login
}

/** The account's status and what the gateway is told, from a failure. */
async function fail(
  server: McpServer,
  error: unknown,
  credential: MailCredential,
): Promise<{ status: "auth_required" | "error"; message: string }> {
  const scrub = makeRedactor(credential.redact)

  if (error instanceof MailAuthError) {
    const message =
      server.authType === "oauth"
        ? `${server.name} needs to be connected: open it in PCP and choose Connect.`
        : `${server.name} refused the credentials PCP sent: ${scrub.text(error.message)}`
    await setServerStatus(server.id, "auth_required", message)
    return { status: "auth_required", message }
  }

  const message = scrub
    .text(
      error instanceof Error
        ? `${server.name}: ${error.message}`
        : `${server.name} could not be reached.`,
    )
    .slice(0, 500)
  await setServerStatus(server.id, "error", message)
  return { status: "error", message }
}

/**
 * Checks the account (the JMAP session, or the IMAP and SMTP logins) and
 * writes its tools into the catalogue. A failure keeps the tools it had.
 */
export async function syncMailTools(
  server: McpServer,
  credential: MailCredential,
  { imap = defaultImapDeps }: { imap?: ImapDeps } = {},
): Promise<SyncResult> {
  const kind = server.kind as MailKind

  try {
    let canSend: boolean

    if (kind === "jmap") {
      const session = await fetchJmapSession(server.url, credential)
      await db().mcpServer.update({
        where: { id: server.id },
        data: {
          mailApiUrl: session.apiUrl,
          mailDownloadUrl: session.downloadUrl,
          mailAccountId: session.accountId,
          mailSubmission: session.submission,
        },
      })
      canSend = session.submission
    } else {
      await checkImapAccount(
        imapConfig(server),
        loginOf(server, credential),
        imap,
      )
      canSend = server.smtpUrl !== null
    }

    const toolCount = await storeTools(
      server.id,
      mailTools({ kind, readOnly: server.readOnly, canSend }),
    )
    await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })

    return { status: "ok", message: "", toolCount }
  } catch (error) {
    if (isPcpError(error)) {
      await setServerStatus(server.id, "error", error.message)
      return { status: "error", message: error.message, toolCount: 0 }
    }

    return { ...(await fail(server, error, credential)), toolCount: 0 }
  }
}

async function openBackend(
  server: McpServer,
  credential: MailCredential,
  imap: ImapDeps,
): Promise<MailBackend> {
  if (server.kind === "imap") {
    return openImapBackend(
      imapConfig(server),
      loginOf(server, credential),
      imap,
    )
  }

  let session =
    server.mailApiUrl && server.mailAccountId
      ? {
          apiUrl: server.mailApiUrl,
          downloadUrl: server.mailDownloadUrl,
          accountId: server.mailAccountId,
          submission: server.mailSubmission,
        }
      : null

  // Not read since the address or sign-in changed: read it now.
  if (!session) {
    session = await fetchJmapSession(server.url, credential)
    await db().mcpServer.update({
      where: { id: server.id },
      data: {
        mailApiUrl: session.apiUrl,
        mailDownloadUrl: session.downloadUrl,
        mailAccountId: session.accountId,
        mailSubmission: session.submission,
      },
    })
  }

  return openJmapBackend({ ...session, from: server.mailFrom }, credential)
}

type Kept = { id: string; length: number; readableUntil: string } | undefined

/** Text an answer carries the start of, with the whole kept when longer. */
async function firstChars(
  text: string,
  {
    keep,
    server,
    toolName,
  }: { keep?: ResultKeeper; server: McpServer; toolName: string },
): Promise<{ text: string; truncated: boolean; result?: Kept }> {
  if (text.length <= MAX_BODY_CHARS) {
    return { text, truncated: false }
  }

  const shown = text.slice(0, MAX_BODY_CHARS)

  if (!keep) {
    return { text: shown, truncated: true }
  }

  const kept = await keep({
    text,
    mediaType: "text/plain",
    serverId: server.id,
    toolName,
  })

  return {
    text: shown,
    truncated: true,
    result: {
      id: kept.id,
      length: kept.length,
      readableUntil: kept.expiresAt.toISOString(),
    },
  }
}

async function runTool(
  backend: MailBackend,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    keep,
    scrub,
  }: { keep?: ResultKeeper; scrub: ReturnType<typeof makeRedactor> },
): Promise<unknown> {
  switch (toolName) {
    case "list_mailboxes":
      return { mailboxes: await backend.listMailboxes() }

    case "search_emails": {
      const query: SearchQuery = {
        ...(args as Partial<SearchQuery>),
        offset: (args.offset as number | undefined) ?? 0,
        limit: (args.limit as number | undefined) ?? DEFAULT_SEARCH_LIMIT,
      }
      return backend.searchEmails(query)
    }

    case "get_email": {
      const email = await backend.getEmail(String(args.id), {
        bodyBytes: keep ? MAX_FULL_BODY_BYTES : MAX_BODY_CHARS * 4,
      })
      const body = await firstChars(scrub.text(email.body.text), {
        keep,
        server,
        toolName,
      })

      return {
        ...email,
        body: {
          ...body,
          source: email.body.source,
          ...(body.result
            ? {
                note: `text holds the first ${MAX_BODY_CHARS} characters; read_result reads the whole body from result.id.`,
              }
            : {}),
          ...(email.body.truncated
            ? {
                cut: `PCP read only the first ${Math.round((keep ? MAX_FULL_BODY_BYTES : MAX_BODY_CHARS * 4) / 1024)} KB of the body.`,
              }
            : {}),
        },
      }
    }

    case "get_attachment": {
      const attachment = await backend.getAttachment(
        String(args.id),
        String(args.attachment),
        { maxBytes: MAX_ATTACHMENT_BYTES },
      )

      if (attachment.text === null) {
        throw new MailRequestError(
          `${attachment.name ?? "That attachment"} is ${attachment.type}; PCP passes on text attachments only.`,
        )
      }

      const content = await firstChars(scrub.text(attachment.text), {
        keep,
        server,
        toolName,
      })

      return {
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        ...content,
      }
    }

    case "get_thread": {
      if (!backend.getThread) break
      return {
        threadId: args.threadId,
        emails: await backend.getThread(String(args.threadId)),
      }
    }

    case "list_identities": {
      if (!backend.listIdentities) break
      return { identities: await backend.listIdentities() }
    }

    case "send_email": {
      if (!backend.sendEmail) break
      return {
        sent: await backend.sendEmail({
          to: parseRecipients(args.to),
          cc: parseRecipients(args.cc),
          bcc: parseRecipients(args.bcc),
          subject: String(args.subject ?? ""),
          text: String(args.text ?? ""),
          ...(args.inReplyTo ? { inReplyTo: String(args.inReplyTo) } : {}),
          ...(args.identity ? { identity: String(args.identity) } : {}),
        }),
      }
    }

    case "move_email":
      return backend.moveEmail(String(args.id), String(args.mailbox))

    case "mark_email":
      return backend.markEmail(String(args.id), {
        ...(args.read !== undefined ? { read: Boolean(args.read) } : {}),
        ...(args.flagged !== undefined
          ? { flagged: Boolean(args.flagged) }
          : {}),
      })

    case "delete_email":
      return backend.deleteEmail(String(args.id))
  }

  throw new PcpError(
    "state",
    `${server.name} cannot ${toolName.replace(/_/g, " ")}.`,
  )
}

/** Runs one mail tool for an assistant. */
export async function callMailTool(
  server: McpServer,
  toolName: string,
  rawArgs: Record<string, unknown>,
  {
    credential,
    keep,
    imap = defaultImapDeps,
  }: { credential: MailCredential; keep?: ResultKeeper; imap?: ImapDeps },
): Promise<CallToolResult> {
  const kind = server.kind as MailKind
  const spec = mailToolSpec(toolName)

  if (!spec || !spec.kinds.includes(kind)) {
    throw new PcpError(
      "state",
      `${server.name} has no tool called ${toolName}.`,
    )
  }

  if (server.readOnly && spec.writes) {
    throw new PcpError(
      "forbidden",
      `${server.name} is read-only in PCP; ${toolName} would change mail.`,
    )
  }

  // Checked before anything is opened: a bad argument never reaches the server.
  const args = parseMailArgs(spec, kind, rawArgs)

  if (toolName === "send_email") {
    for (const key of ["to", "cc", "bcc"] as const) {
      parseRecipients(args[key])
    }
  }

  let backend: MailBackend | null = null

  try {
    backend = await openBackend(server, credential, imap)
    const scrub = makeRedactor(credential.redact)
    const value = await runTool(backend, server, toolName, args, {
      keep,
      scrub,
    })

    return jsonToolResult(value, { redact: credential.redact })
  } catch (error) {
    if (error instanceof MailRequestError) {
      return errorToolResult(error.message, { redact: credential.redact })
    }

    if (isPcpError(error)) {
      throw error
    }

    const failure = await fail(server, error, credential)
    throw new PcpError(
      failure.status === "auth_required" ? "unauthorized" : "upstream",
      failure.message,
    )
  } finally {
    await backend?.close().catch(() => {})
  }
}
