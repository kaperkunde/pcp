import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"

import type {
  FetchMessageObject,
  FetchQueryObject,
  MessageAddressObject,
  MessageStructureObject,
  SearchObject,
} from "imapflow"

import { describeFetchError } from "../openapi/http"
import { PCP_VERSION } from "../version"
import type { MailServerAddress } from "./addresses"
import { htmlToText } from "./html"
import {
  MAIL_CALL_TIMEOUT_MS,
  MAIL_CONNECT_TIMEOUT_MS,
  MAX_ATTACHMENTS_LISTED,
  MAX_MAILBOXES,
} from "./limits"
import { findMailbox, mailboxByRole } from "./mailboxes"
import { bareType, isTextType } from "../media-types"
import {
  MailAuthError,
  MailRequestError,
  MailTransportError,
  type AttachmentContent,
  type MailAddress,
  type MailBackend,
  type MailboxRole,
  type MailboxSummary,
  type MailMessageDetail,
  type MailMessageSummary,
  type MoveResult,
  type SearchQuery,
  type SearchResult,
  type SendInput,
  type SendResult,
} from "./types"

/**
 * A mail account over IMAP, with sending over SMTP when the owner gave an
 * SMTP server. One connection per call: PCP connects, signs in, does the
 * one thing and logs out. Mail never travels in the clear: imaps:// and
 * smtps:// are TLS from the start, imap:// and smtp:// must upgrade with
 * STARTTLS, and a connection that is not encrypted is dropped.
 *
 * An email's id is "<uid>.<uidvalidity>.<mailbox path, base64url>", so it
 * says where the email is and stops working, rather than naming another
 * email, if the mailbox is rebuilt.
 *
 * The libraries are reached through ImapDeps, which the tests replace.
 */

export type Login = { username: string; password: string }

/** The part of an imapflow client PCP uses. */
export interface ImapClientLike {
  readonly secureConnection: boolean
  readonly mailbox: { path: string; uidValidity: bigint } | false
  logout(): Promise<void>
  close(): void
  list(options?: {
    statusQuery?: { messages?: boolean; unseen?: boolean }
  }): Promise<
    Array<{
      path: string
      name: string
      parentPath: string
      flags: Set<string>
      specialUse?: string
      status?: { messages?: number; unseen?: number }
    }>
  >
  getMailboxLock(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<{ path: string; release(): void }>
  search(
    query: SearchObject,
    options: { uid: true },
  ): Promise<number[] | false | undefined>
  fetchAll(
    range: number[] | string,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject[]>
  fetchOne(
    uid: string,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject | false | undefined>
  download(
    uid: string,
    part: string | undefined,
    options: { uid: true; maxBytes: number },
  ): Promise<{
    meta?: { expectedSize?: number; contentType?: string }
    content?: Readable
  }>
  messageMove(
    range: string,
    destination: string,
    options: { uid: true },
  ): Promise<{ uidMap?: Map<number, number>; uidValidity?: bigint } | false>
  messageFlagsAdd(
    range: string,
    flags: string[],
    options: { uid: true },
  ): Promise<boolean>
  messageFlagsRemove(
    range: string,
    flags: string[],
    options: { uid: true },
  ): Promise<boolean>
  append(
    path: string,
    content: Buffer,
    flags?: string[],
  ): Promise<{ uid?: number; uidValidity?: bigint } | false>
}

export type OutgoingMail = {
  from: { name: string; address: string }
  to: Array<{ name: string; address: string }>
  cc: Array<{ name: string; address: string }>
  bcc: Array<{ name: string; address: string }>
  subject: string
  text: string
  messageId: string
  inReplyTo?: string
  references?: string[]
  attachments?: Array<{
    filename: string
    contentType: string
    content: Buffer
  }>
}

export interface SmtpTransportLike {
  sendMail(mail: OutgoingMail): Promise<{
    messageId?: string
    accepted?: unknown[]
    rejected?: unknown[]
  }>
  verify(): Promise<unknown>
  close(): void
}

export type ImapDeps = {
  /** A connected, signed-in client. */
  connect(address: MailServerAddress, login: Login): Promise<ImapClientLike>
  smtp(address: MailServerAddress, login: Login): Promise<SmtpTransportLike>
  /** The message as it goes into the Sent mailbox, Bcc kept. */
  compose(mail: OutgoingMail): Promise<Buffer>
}

export const defaultImapDeps: ImapDeps = {
  async connect(address, login) {
    const { ImapFlow } = await import("imapflow")
    const client = new ImapFlow({
      host: address.host,
      port: address.port,
      secure: address.secure,
      // Upgrade or fail: never sign in over a connection in the clear.
      ...(address.secure ? {} : { doSTARTTLS: true }),
      auth: { user: login.username, pass: login.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: MAIL_CONNECT_TIMEOUT_MS,
      greetingTimeout: MAIL_CONNECT_TIMEOUT_MS,
      socketTimeout: MAIL_CALL_TIMEOUT_MS,
      clientInfo: { name: "PCP", version: PCP_VERSION },
    })
    // Without a listener, an error after the call returns would be thrown
    // as an uncaught exception.
    client.on("error", () => {})
    await client.connect()

    return client as unknown as ImapClientLike
  },

  async smtp(address, login) {
    // Loaded when used, like imapflow, so nothing mail-related loads until
    // an account is.
    const nodemailer = await import("nodemailer")

    return nodemailer.createTransport({
      host: address.host,
      port: address.port,
      secure: address.secure,
      requireTLS: !address.secure,
      auth: { user: login.username, pass: login.password },
      connectionTimeout: MAIL_CONNECT_TIMEOUT_MS,
      greetingTimeout: MAIL_CONNECT_TIMEOUT_MS,
      socketTimeout: MAIL_CALL_TIMEOUT_MS,
    }) as unknown as SmtpTransportLike
  },

  async compose(mail) {
    const { default: MailComposer } =
      await import("nodemailer/lib/mail-composer")
    const node = new MailComposer(mail).compile()
    node.keepBcc = true

    return node.build()
  },
}

const ROLES: Record<string, MailboxRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "all",
  "\\flagged": "flagged",
  "\\important": "important",
}

export function mailboxRole(box: {
  path: string
  specialUse?: string
  flags?: Set<string>
}): MailboxRole | null {
  if (box.path.toUpperCase() === "INBOX") {
    return "inbox"
  }

  const flags = [box.specialUse, ...(box.flags ?? [])].filter(
    (flag): flag is string => typeof flag === "string",
  )

  for (const flag of flags) {
    const role = ROLES[flag.toLowerCase()]

    if (role) {
      return role
    }
  }

  return null
}

export function encodeImapId(
  uid: number,
  uidValidity: bigint,
  path: string,
): string {
  return `${uid}.${uidValidity}.${Buffer.from(path).toString("base64url")}`
}

export function decodeImapId(id: string): {
  uid: number
  uidValidity: bigint
  path: string
} {
  const match = /^(\d{1,10})\.(\d{1,20})\.([A-Za-z0-9_-]+)$/.exec(id)

  if (!match) {
    throw new MailRequestError(
      "That is not an email id from this account; search_emails gives them.",
    )
  }

  return {
    uid: Number(match[1]),
    uidValidity: BigInt(match[2]!),
    path: Buffer.from(match[3]!, "base64url").toString("utf8"),
  }
}

type Parts = {
  text: MessageStructureObject | null
  html: MessageStructureObject | null
  attachments: Array<{
    part: string
    name: string | null
    type: string
    size: number | null
  }>
}

function filename(node: MessageStructureObject): string | null {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? null
}

/**
 * The parts worth reading: the first plain-text and HTML parts that are not
 * attachments, and the attachments themselves with their part numbers.
 */
export function pickParts(
  structure: MessageStructureObject | undefined,
): Parts {
  const parts: Parts = { text: null, html: null, attachments: [] }

  const walk = (node: MessageStructureObject) => {
    if (node.childNodes?.length) {
      node.childNodes.forEach(walk)
      return
    }

    const type = bareType(node.type ?? "")
    const part = node.part ?? "1"
    const attached =
      node.disposition?.toLowerCase() === "attachment" ||
      (filename(node) !== null &&
        node.disposition?.toLowerCase() !== "inline") ||
      !(type.startsWith("text/") || type === "message/delivery-status")

    if (!attached && type === "text/plain" && !parts.text) {
      parts.text = { ...node, part }
    } else if (!attached && type === "text/html" && !parts.html) {
      parts.html = { ...node, part }
    } else if (attached || (type.startsWith("text/") && filename(node))) {
      parts.attachments.push({
        part,
        name: filename(node),
        type: node.type ?? "application/octet-stream",
        size: typeof node.size === "number" ? node.size : null,
      })
    }
  }

  if (structure) {
    walk(structure)
  }

  return parts
}

function address(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? []).flatMap((entry) =>
    entry.address ? [{ name: entry.name || null, email: entry.address }] : [],
  )
}

function bare(messageId: string | undefined): string | null {
  return messageId ? messageId.trim().replace(/^<|>$/g, "") : null
}

function messageIds(header: string): string[] {
  return [...header.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!)
}

function isoDate(value: Date | string | undefined): string | null {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

async function readStream(
  stream: Readable | undefined,
  max: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!stream) {
    return { bytes: Buffer.alloc(0), truncated: false }
  }

  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array)

    if (size + buffer.length > max) {
      chunks.push(buffer.subarray(0, max - size))
      stream.destroy()
      return { bytes: Buffer.concat(chunks), truncated: true }
    }

    chunks.push(buffer)
    size += buffer.length
  }

  return { bytes: Buffer.concat(chunks), truncated: false }
}

const SUMMARY_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  flags: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  threadId: true,
}

/** What went wrong, in terms the account's status and the assistant use. */
export function describeImapError(error: unknown, what: string): Error {
  if (
    error instanceof MailAuthError ||
    error instanceof MailRequestError ||
    error instanceof MailTransportError
  ) {
    return error
  }

  const detail = error as {
    authenticationFailed?: boolean
    responseStatus?: string
    responseText?: string
    code?: string
    responseCode?: number
    tlsFailed?: boolean
    mailboxMissing?: boolean
  }

  if (detail?.authenticationFailed || detail?.code === "EAUTH") {
    return new MailAuthError(
      `The ${what} server refused the user name and password.`,
    )
  }

  if (detail?.mailboxMissing) {
    return new MailRequestError(
      "That mailbox is not there any more; list_mailboxes lists them.",
    )
  }

  if (detail?.responseStatus === "NO" || detail?.responseStatus === "BAD") {
    return new MailRequestError(
      `The ${what} server said no${detail.responseText ? `: ${detail.responseText.slice(0, 300)}` : "."}`,
    )
  }

  // SMTP refusals of a message (550 and friends) are about this message.
  if (
    typeof detail?.responseCode === "number" &&
    detail.responseCode >= 500 &&
    detail.code !== "ECONNECTION"
  ) {
    return new MailRequestError(
      `The ${what} server did not take the email: ${String((error as Error).message ?? "").slice(0, 300)}`,
    )
  }

  if (detail?.tlsFailed || detail?.code === "ETLS") {
    return new MailTransportError(
      `The ${what} server could not be reached over an encrypted connection: ${describeFetchError(error, MAIL_CALL_TIMEOUT_MS)}`,
    )
  }

  return new MailTransportError(
    `The ${what} server could not be reached: ${describeFetchError(error, MAIL_CALL_TIMEOUT_MS)}`,
  )
}

export type ImapConfig = {
  imap: MailServerAddress
  smtp: MailServerAddress | null
  /** The From address; the user name when it is one. */
  from: string | null
}

/** Signs in to the IMAP server, and the SMTP one when there is one. */
export async function checkImapAccount(
  config: ImapConfig,
  login: Login,
  deps: ImapDeps = defaultImapDeps,
): Promise<void> {
  const backend = openImapBackend(config, login, deps)

  try {
    await backend.listMailboxes()
  } finally {
    await backend.close()
  }

  if (config.smtp) {
    const transport = await deps.smtp(config.smtp, login)

    try {
      await transport.verify()
    } catch (error) {
      throw describeImapError(error, "SMTP")
    } finally {
      transport.close()
    }
  }
}

export function openImapBackend(
  config: ImapConfig,
  login: Login,
  deps: ImapDeps = defaultImapDeps,
): MailBackend {
  let connection: Promise<ImapClientLike> | null = null

  async function client(): Promise<ImapClientLike> {
    connection ??= (async () => {
      let connected: ImapClientLike

      try {
        connected = await deps.connect(config.imap, login)
      } catch (error) {
        throw describeImapError(error, "IMAP")
      }

      if (!connected.secureConnection) {
        connected.close()
        throw new MailTransportError(
          "The IMAP connection is not encrypted, so PCP will not use it.",
        )
      }

      return connected
    })()

    return connection
  }

  /** Runs with one mailbox open, its lock released however it ends. */
  async function inMailbox<T>(
    path: string,
    readOnly: boolean,
    run: (imap: ImapClientLike, uidValidity: bigint) => Promise<T>,
  ): Promise<T> {
    const imap = await client()
    let lock: { release(): void }

    try {
      lock = await imap.getMailboxLock(path, { readOnly })
    } catch (error) {
      throw describeImapError(error, "IMAP")
    }

    try {
      const opened = imap.mailbox
      return await run(imap, opened ? opened.uidValidity : 0n)
    } catch (error) {
      throw describeImapError(error, "IMAP")
    } finally {
      lock.release()
    }
  }

  /** The email an id names, in its mailbox, if the mailbox is unchanged. */
  async function withEmail<T>(
    id: string,
    readOnly: boolean,
    run: (imap: ImapClientLike, uid: string, path: string) => Promise<T>,
  ): Promise<T> {
    const { uid, uidValidity, path } = decodeImapId(id)

    return inMailbox(path, readOnly, (imap, current) => {
      if (current !== uidValidity) {
        throw new MailRequestError(
          "That email id is from before its mailbox changed; search again for a fresh one.",
        )
      }

      return run(imap, String(uid), path)
    })
  }

  function summary(
    message: FetchMessageObject,
    path: string,
    uidValidity: bigint,
  ): MailMessageSummary {
    const flags = message.flags ?? new Set<string>()
    const envelope = message.envelope ?? {}

    return {
      id: encodeImapId(message.uid, uidValidity, path),
      threadId: message.threadId ?? null,
      mailboxIds: [path],
      date: isoDate(message.internalDate) ?? isoDate(envelope.date),
      from: address(envelope.from),
      to: address(envelope.to),
      cc: address(envelope.cc),
      subject: envelope.subject ?? "",
      preview: "",
      flags: {
        unread: !flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        answered: flags.has("\\Answered"),
        draft: flags.has("\\Draft"),
      },
      hasAttachments: pickParts(message.bodyStructure).attachments.length > 0,
      size: typeof message.size === "number" ? message.size : null,
    }
  }

  async function mailboxes(): Promise<MailboxSummary[]> {
    const imap = await client()
    let listed: Awaited<ReturnType<ImapClientLike["list"]>>

    try {
      listed = await imap.list({
        statusQuery: { messages: true, unseen: true },
      })
    } catch (error) {
      throw describeImapError(error, "IMAP")
    }

    return listed.slice(0, MAX_MAILBOXES).map((box) => ({
      id: box.path,
      name: box.name,
      path: box.path,
      role: mailboxRole(box),
      parentId: box.parentPath || null,
      totalEmails: box.status?.messages ?? null,
      unreadEmails: box.status?.unseen ?? null,
    }))
  }

  async function headers(imap: ImapClientLike, uid: string) {
    const message = await imap.fetchOne(
      uid,
      { uid: true, envelope: true, headers: ["references"] },
      { uid: true },
    )

    if (!message) {
      throw new MailRequestError("No email with that id.")
    }

    return {
      messageId: bare(message.envelope?.messageId),
      references: messageIds(message.headers?.toString("utf8") ?? ""),
    }
  }

  async function move(id: string, target: MailboxSummary): Promise<MoveResult> {
    return withEmail(id, false, async (imap, uid, path) => {
      if (target.id === path) {
        return { id, previousId: id, mailboxId: target.id }
      }

      const moved = await imap.messageMove(uid, target.id, { uid: true })

      if (!moved) {
        throw new MailRequestError("No email with that id.")
      }

      const newUid = moved.uidMap?.get(Number(uid))

      return {
        id:
          newUid !== undefined && moved.uidValidity !== undefined
            ? encodeImapId(newUid, moved.uidValidity, target.id)
            : null,
        previousId: id,
        mailboxId: target.id,
      }
    })
  }

  const backend: MailBackend = {
    listMailboxes: mailboxes,

    async searchEmails(query: SearchQuery): Promise<SearchResult> {
      const boxes = await mailboxes()
      const box = query.mailbox
        ? findMailbox(boxes, query.mailbox)
        : (mailboxByRole(boxes, "inbox") ?? findMailbox(boxes, "INBOX"))
      const criteria: SearchObject = {}

      if (query.text) criteria.text = query.text
      if (query.from) criteria.from = query.from
      if (query.to) criteria.to = query.to
      if (query.subject) criteria.subject = query.subject
      if (query.after) criteria.since = new Date(Date.parse(query.after))
      if (query.before) criteria.before = new Date(Date.parse(query.before))
      if (query.unread !== undefined) criteria.seen = !query.unread
      if (query.flagged !== undefined) criteria.flagged = query.flagged
      // IMAP has no attachment search; a mixed multipart is the usual sign.
      if (query.hasAttachment === true) {
        criteria.header = { "content-type": "multipart/mixed" }
      } else if (query.hasAttachment === false) {
        criteria.not = { header: { "content-type": "multipart/mixed" } }
      }

      if (Object.keys(criteria).length === 0) {
        criteria.all = true
      }

      return inMailbox(box.id, true, async (imap, uidValidity) => {
        const found = (await imap.search(criteria, { uid: true })) || []
        // Newest first: a higher UID arrived later.
        const page = [...found]
          .sort((a, b) => b - a)
          .slice(query.offset, query.offset + query.limit)
        const messages =
          page.length > 0
            ? await imap.fetchAll(page, SUMMARY_QUERY, { uid: true })
            : []
        const byUid = new Map(messages.map((message) => [message.uid, message]))

        return {
          emails: page.flatMap((uid) =>
            byUid.has(uid)
              ? [summary(byUid.get(uid)!, box.id, uidValidity)]
              : [],
          ),
          total: found.length,
          offset: query.offset,
        }
      })
    },

    async getEmail(id, { bodyBytes }): Promise<MailMessageDetail> {
      const { uidValidity } = decodeImapId(id)

      return withEmail(id, true, async (imap, uid, path) => {
        const message = await imap.fetchOne(
          uid,
          { ...SUMMARY_QUERY, headers: ["references"] },
          { uid: true },
        )

        if (!message) {
          throw new MailRequestError("No email with that id.")
        }

        const parts = pickParts(message.bodyStructure)
        const chosen = parts.text ?? parts.html
        let text = ""
        let truncated = false

        if (chosen) {
          const downloaded = await imap.download(uid, chosen.part, {
            uid: true,
            maxBytes: bodyBytes,
          })
          const read = await readStream(downloaded.content, bodyBytes)
          const expected = downloaded.meta?.expectedSize ?? 0
          truncated = read.truncated || expected > bodyBytes
          text = read.bytes.toString("utf8")

          if (chosen === parts.html) {
            text = htmlToText(text).text
          }
        }

        const envelope = message.envelope ?? {}

        return {
          ...summary(message, path, uidValidity),
          bcc: address(envelope.bcc),
          replyTo: address(envelope.replyTo),
          messageId: bare(envelope.messageId),
          inReplyTo: messageIds(envelope.inReplyTo ?? ""),
          references: messageIds(message.headers?.toString("utf8") ?? ""),
          body: {
            text,
            source: !chosen ? "none" : chosen === parts.text ? "text" : "html",
            truncated,
          },
          attachments: parts.attachments
            .slice(0, MAX_ATTACHMENTS_LISTED)
            .map((attachment) => ({
              id: attachment.part,
              name: attachment.name,
              type: attachment.type,
              size: attachment.size,
            })),
        }
      })
    },

    async moveEmail(id, mailbox): Promise<MoveResult> {
      return move(id, findMailbox(await mailboxes(), mailbox))
    },

    async markEmail(id, flags): Promise<MailMessageSummary> {
      const { uidValidity } = decodeImapId(id)

      return withEmail(id, false, async (imap, uid, path) => {
        const change = async (flag: string, on: boolean | undefined) => {
          if (on === true)
            await imap.messageFlagsAdd(uid, [flag], { uid: true })
          if (on === false)
            await imap.messageFlagsRemove(uid, [flag], { uid: true })
        }

        await change("\\Seen", flags.read)
        await change("\\Flagged", flags.flagged)
        const message = await imap.fetchOne(uid, SUMMARY_QUERY, { uid: true })

        if (!message) {
          throw new MailRequestError("No email with that id.")
        }

        return summary(message, path, uidValidity)
      })
    },

    async deleteEmail(id): Promise<MoveResult> {
      const trash = mailboxByRole(await mailboxes(), "trash")

      if (!trash) {
        throw new MailRequestError(
          "This account has no Trash mailbox, and PCP never deletes an email for good.",
        )
      }

      if (decodeImapId(id).path === trash.id) {
        throw new MailRequestError(
          "That email is in the Trash already, and PCP never deletes an email for good.",
        )
      }

      return move(id, trash)
    },

    async getAttachment(
      id,
      attachment,
      { maxBytes },
    ): Promise<AttachmentContent> {
      return withEmail(id, true, async (imap, uid) => {
        const message = await imap.fetchOne(
          uid,
          { uid: true, bodyStructure: true },
          { uid: true },
        )

        if (!message) {
          throw new MailRequestError("No email with that id.")
        }

        const part = pickParts(message.bodyStructure).attachments.find(
          (candidate) => candidate.part === attachment,
        )

        if (!part) {
          throw new MailRequestError(
            "That email has no attachment with that id; get_email lists them.",
          )
        }

        const meta = { name: part.name, type: part.type, size: part.size ?? 0 }

        if (meta.size > maxBytes) {
          throw new MailRequestError(
            `That attachment is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, more than PCP reads.`,
          )
        }

        const downloaded = await imap.download(uid, part.part, {
          uid: true,
          maxBytes,
        })
        const read = await readStream(downloaded.content, maxBytes)

        // imapflow has undone the transfer encoding, and turned a text
        // part's charset into UTF-8.
        return {
          ...meta,
          size: read.bytes.length,
          bytes: read.bytes,
          charset: isTextType(part.type) ? "utf-8" : null,
        }
      })
    },

    async close() {
      if (!connection) {
        return
      }

      const opened = await connection.catch(() => null)
      connection = null

      if (opened) {
        await opened.logout().catch(() => opened.close())
      }
    },
  }

  if (config.smtp) {
    const smtp = config.smtp

    backend.sendEmail = async (input: SendInput): Promise<SendResult> => {
      const fromAddress =
        config.from ?? (login.username.includes("@") ? login.username : null)

      if (!fromAddress) {
        throw new MailRequestError(
          "This account has no From address; the owner sets one in PCP.",
        )
      }

      let inReplyTo: string | undefined
      let references: string[] | undefined

      if (input.inReplyTo) {
        const original = await withEmail(input.inReplyTo, true, (imap, uid) =>
          headers(imap, uid),
        )

        if (original.messageId) {
          inReplyTo = `<${original.messageId}>`
          references = [...original.references, original.messageId]
            .slice(-20)
            .map((value) => `<${value}>`)
        }
      }

      const domain = fromAddress.split("@")[1] ?? "pcp.invalid"
      const messageId = `<${randomUUID()}@${domain}>`
      const named = (list: MailAddress[]) =>
        list.map((entry) => ({ name: entry.name ?? "", address: entry.email }))
      const mail: OutgoingMail = {
        from: { name: "", address: fromAddress },
        to: named(input.to),
        cc: named(input.cc),
        bcc: named(input.bcc),
        subject: input.subject,
        text: input.text,
        messageId,
        ...(inReplyTo ? { inReplyTo, references } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((attachment) => ({
                filename: attachment.name,
                contentType: attachment.type,
                content: attachment.bytes,
              })),
            }
          : {}),
      }
      const transport = await deps.smtp(smtp, login)
      let sent: Awaited<ReturnType<SmtpTransportLike["sendMail"]>>

      try {
        sent = await transport.sendMail(mail)
      } catch (error) {
        throw describeImapError(error, "SMTP")
      } finally {
        transport.close()
      }

      if (sent.rejected && sent.rejected.length > 0) {
        throw new MailRequestError(
          `The SMTP server refused ${sent.rejected.map(String).join(", ").slice(0, 300)}; the email went to nobody else${sent.accepted?.length ? ` than ${sent.accepted.map(String).join(", ").slice(0, 300)}` : ""}.`,
        )
      }

      // A reply marks the email it answers, as mail apps do; the email has
      // gone whatever happens here, so a refusal is reported, not thrown.
      let answered: boolean | undefined

      if (input.inReplyTo) {
        try {
          answered =
            (await withEmail(input.inReplyTo, false, (imap, uid) =>
              imap.messageFlagsAdd(uid, ["\\Answered"], { uid: true }),
            )) !== false
        } catch {
          answered = false
        }
      }

      // The sent copy: best effort, since the email has gone whatever
      // happens here.
      let savedTo: string | null = null
      let id: string | null = null

      try {
        const sentBox = mailboxByRole(await mailboxes(), "sent")

        if (sentBox) {
          const raw = await deps.compose(mail)
          const imap = await client()
          const appended = await imap.append(sentBox.id, raw, ["\\Seen"])
          savedTo = sentBox.id

          if (
            appended &&
            appended.uid !== undefined &&
            appended.uidValidity !== undefined
          ) {
            id = encodeImapId(appended.uid, appended.uidValidity, sentBox.id)
          }
        }
      } catch {
        savedTo = null
      }

      return {
        id,
        messageId: bare(sent.messageId ?? messageId),
        from: { name: null, email: fromAddress },
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        savedTo,
        ...(answered !== undefined ? { answered } : {}),
      }
    }
  }

  return backend
}
