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

/** Keywords the flags carry, so keywords leaves them out. */
const FLAG_KEYWORDS = new Set(["$seen", "$flagged", "$answered", "$draft"])

/**
 * An email's keywords other than the ones its flags say, lowercased, as
 * JMAP has them and IMAP flags without a backslash are.
 */
export function otherKeywords(names: Iterable<string>): string[] {
  const out = new Set<string>()

  for (const name of names) {
    const lower = name.toLowerCase()

    if (!name.startsWith("\\") && !FLAG_KEYWORDS.has(lower)) {
      out.add(lower)
    }
  }

  return [...out].sort()
}

export type MailboxSummary = {
  /** What the other tools take: a JMAP id, an IMAP path. */
  id: string
  name: string
  /**
   * The full path: IMAP's with its delimiter, JMAP's the names from the top
   * joined with "/".
   */
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
  /**
   * The email's other keywords (labels), lowercased: JMAP keywords and IMAP
   * flags other than the ones flags carries.
   */
  keywords: string[]
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
  /** Every mailbox but Trash and Junk, instead of one. */
  allMailboxes?: boolean
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
  /** A keyword the email has, or does not have. */
  keyword?: string
  notKeyword?: string
  offset: number
  limit: number
}

export type SearchResult = {
  emails: MailMessageSummary[]
  /** How many match in all, when the server says. */
  total: number | null
  offset: number
  /** Something the answer leaves out, said in words. */
  note?: string
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
  /** Files to attach, read from results the token kept. */
  attachments?: Array<{ name: string; type: string; bytes: Buffer }>
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
  /**
   * With inReplyTo: whether the email it answers is now marked as answered.
   * False when the server refused that; the email was sent all the same.
   */
  answered?: boolean
}

export type DraftResult = {
  /**
   * The draft's id, for get_email. Null when the server does not say what
   * it is (IMAP without UIDPLUS).
   */
  id: string | null
  messageId: string | null
  /** Null when the account names no From address to write in. */
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  /** The Drafts mailbox: its id (a JMAP id, an IMAP path) and name. */
  mailboxId: string
  mailbox: string
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

/** What mark_email changes; what is left out stays as it is. */
export type MarkChange = {
  read?: boolean
  flagged?: boolean
  answered?: boolean
  /** Keywords, lowercased and checked (tools.ts). */
  addKeywords?: string[]
  removeKeywords?: string[]
}

/**
 * A change to several emails at once: the ones it was made to, and the
 * ones it was not, each with why. One email's refusal stops no other.
 */
export type BulkResult<T> = {
  done: T[]
  failed: Array<{ id: string; error: string }>
}

/** A mailbox's new name or place; parent null is the top level. */
export type MailboxChange = {
  name?: string
  parent?: string | null
}

/** JMAP's VacationResponse (RFC 8621 8): the automatic reply. */
export type VacationResponse = {
  enabled: boolean
  /** ISO 8601; null for no bound. */
  from: string | null
  to: string | null
  subject: string | null
  text: string | null
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
  /** Writes the email into Drafts, marked as a draft; sends nothing. */
  createDraft(input: SendInput): Promise<DraftResult>
  moveEmails(ids: string[], mailbox: string): Promise<BulkResult<MoveResult>>
  markEmails(
    ids: string[],
    change: MarkChange,
  ): Promise<BulkResult<MailMessageSummary>>
  /** Moves them to the Trash; never deletes one for good. */
  deleteEmails(ids: string[]): Promise<BulkResult<MoveResult>>
  createMailbox(name: string, parent?: string): Promise<MailboxSummary>
  renameMailbox(mailbox: string, change: MailboxChange): Promise<MailboxSummary>
  /**
   * Removes an empty mailbox that has no role and no mailboxes inside it;
   * never one that holds mail.
   */
  deleteMailbox(mailbox: string): Promise<MailboxSummary>
  getVacationResponse?(): Promise<VacationResponse>
  setVacationResponse?(
    change: Partial<VacationResponse> & { enabled: boolean },
  ): Promise<VacationResponse>
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
