/**
 * What a mail account looks like to the rest of PCP, whichever protocol it
 * speaks: one backend interface (JMAP in jmap.ts, IMAP in imap.ts) and the
 * shapes the mail tools answer with, so an assistant sees the same tools
 * and the same answers for both.
 *
 * Nothing here reads a secret: upstream.ts hands in a MailCredential with
 * the header or login already made, and the values to keep out of answers.
 */

export type MailProtocol = "jmap" | "imap"

export type MailCredential = {
  /** Sent with each JMAP request (Authorization). */
  headers: Record<string, string>
  /** An IMAP or SMTP login; null for a bearer or OAuth token. */
  login: { username: string; password: string } | null
  /** Values that would give the credential away if an answer repeated them. */
  redact: string[]
  /**
   * OAuth: renew the token after the server refused it, and hand back the
   * new header; null when the owner has to connect again.
   */
  onUnauthorized?: () => Promise<{
    headers: Record<string, string>
    redact: string[]
  } | null>
}

export type MailboxRole =
  | "inbox"
  | "drafts"
  | "sent"
  | "trash"
  | "junk"
  | "archive"
  | "all"
  | "flagged"
  | "important"

export const MAILBOX_ROLES: readonly MailboxRole[] = [
  "inbox",
  "drafts",
  "sent",
  "trash",
  "junk",
  "archive",
  "all",
  "flagged",
  "important",
]

export type MailboxSummary = {
  /** What the other tools take: a JMAP id, an IMAP path. */
  id: string
  name: string
  /** IMAP: the full path, with its delimiter; null for JMAP. */
  path: string | null
  role: MailboxRole | null
  parentId: string | null
  totalEmails: number | null
  unreadEmails: number | null
}

export type MailAddress = { name: string | null; email: string }

export type MailFlags = {
  unread: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
}

export type MailMessageSummary = {
  id: string
  threadId: string | null
  mailboxIds: string[]
  /** ISO 8601. */
  date: string | null
  from: MailAddress[]
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  /** A short start of the text; empty where the server gives none (IMAP). */
  preview: string
  flags: MailFlags
  hasAttachments: boolean
  size: number | null
}

export type MailAttachment = {
  /** What get_attachment takes: a JMAP blob id, an IMAP part number. */
  id: string
  name: string | null
  type: string
  size: number | null
}

export type MailBody = {
  text: string
  /** Where the text came from: the plain part, or the HTML one made plain. */
  source: "text" | "html" | "none"
  /** The server held more than PCP fetched. */
  truncated: boolean
}

export type MailMessageDetail = MailMessageSummary & {
  bcc: MailAddress[]
  replyTo: MailAddress[]
  messageId: string | null
  inReplyTo: string[]
  references: string[]
  body: MailBody
  attachments: MailAttachment[]
}

export type MailIdentity = {
  id: string
  name: string
  email: string
}

export type SearchQuery = {
  /** A mailbox id, or a role ("inbox"). */
  mailbox?: string
  text?: string
  from?: string
  to?: string
  subject?: string
  /** ISO 8601 date or date-time. */
  after?: string
  before?: string
  unread?: boolean
  flagged?: boolean
  hasAttachment?: boolean
  offset: number
  limit: number
}

export type SearchResult = {
  emails: MailMessageSummary[]
  /** How many match in all, when the server says. */
  total: number | null
  offset: number
}

export type SendInput = {
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  text: string
  /** The id of the email this replies to. */
  inReplyTo?: string
  /** JMAP: the identity to send as. */
  identity?: string
}

export type SendResult = {
  /** The sent email's id, where the server keeps a copy PCP can name. */
  id: string | null
  messageId: string | null
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  /** The mailbox the sent copy is in, when there is one. */
  savedTo: string | null
}

export type MoveResult = {
  /**
   * The email's id now; an IMAP message gets a new one when it moves. Null
   * when the server does not say what it is (IMAP without UIDPLUS).
   */
  id: string | null
  previousId: string
  mailboxId: string
}

export type AttachmentContent = {
  name: string | null
  type: string
  size: number
  /** The attachment's bytes, its transfer encoding undone. */
  bytes: Buffer
  /** The charset its text is in, when it is text and says one. */
  charset: string | null
}

export interface MailBackend {
  listMailboxes(): Promise<MailboxSummary[]>
  searchEmails(query: SearchQuery): Promise<SearchResult>
  /** The body up to bodyBytes; truncated says when there was more. */
  getEmail(
    id: string,
    options: { bodyBytes: number },
  ): Promise<MailMessageDetail>
  getThread?(threadId: string): Promise<MailMessageSummary[]>
  listIdentities?(): Promise<MailIdentity[]>
  sendEmail?(input: SendInput): Promise<SendResult>
  moveEmail(id: string, mailbox: string): Promise<MoveResult>
  markEmail(
    id: string,
    flags: { read?: boolean; flagged?: boolean },
  ): Promise<MailMessageSummary>
  /** Moves it to the Trash; never deletes it for good. */
  deleteEmail(id: string): Promise<MoveResult>
  getAttachment(
    id: string,
    attachment: string,
    options: { maxBytes: number },
  ): Promise<AttachmentContent>
  close(): Promise<void>
}

/** The server refused the credentials (after a renewal, for OAuth). */
export class MailAuthError extends Error {
  override name = "MailAuthError"
}

/** The server could not be reached, or did not speak the protocol. */
export class MailTransportError extends Error {
  override name = "MailTransportError"
}

/**
 * The account is fine, but this request could not be done: no such email
 * or mailbox, the server refused the method, no Trash to delete into. The
 * assistant is told; the account's status stays as it is.
 */
export class MailRequestError extends Error {
  override name = "MailRequestError"
}
