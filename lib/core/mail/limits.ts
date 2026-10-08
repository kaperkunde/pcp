/** Bounds on what a mail account is asked for and what PCP passes on. */

export const MAIL_CONNECT_TIMEOUT_MS = 20_000
export const MAIL_CALL_TIMEOUT_MS = 60_000

/** The most PCP reads of one JMAP answer. */
export const MAX_JMAP_RESPONSE_BYTES = 4 * 1024 * 1024
/** The most of a body PCP fetches when it can keep the whole of it. */
export const MAX_FULL_BODY_BYTES = 2 * 1024 * 1024
/** The body text get_email carries itself; the rest is kept for read_result. */
export const MAX_BODY_CHARS = 20_000
export const MAX_PREVIEW_CHARS = 256

export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 50
export const MAX_SEARCH_OFFSET = 10_000
export const MAX_THREAD_EMAILS = 50
export const MAX_MAILBOXES = 500
export const MAX_ATTACHMENTS_LISTED = 100

export const MAX_RECIPIENTS = 50
export const MAX_SUBJECT_CHARS = 500
export const MAX_SEND_TEXT_CHARS = 100_000
/** Files one email may carry, and their size together. */
export const MAX_SEND_ATTACHMENTS = 10
export const MAX_SEND_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_SEARCH_TEXT_CHARS = 500

/** Emails one move_email, mark_email or delete_email changes. */
export const MAX_BULK_EMAILS = 100
/** Keywords one mark_email adds or removes. */
export const MAX_KEYWORDS = 20
export const MAX_KEYWORD_CHARS = 255
export const MAX_MAILBOX_NAME_CHARS = 200
/** IMAP: mailboxes a search of every mailbox looks in, one at a time. */
export const MAX_SEARCH_MAILBOXES = 50
/**
 * IMAP: how far a search of every mailbox pages (offset + limit), since
 * each mailbox hands over that many of its newest to be merged.
 */
export const MAX_SEARCH_ALL_WINDOW = 500
export const MAX_VACATION_SUBJECT_CHARS = 500

/*
 * An attachment get_attachment reads and keeps for the token is at most the
 * largest file PCP keeps (`resourceLimits().fileBytes`), so one that is read
 * can always be kept; larger ones are refused.
 */
/** The start of a text attachment get_attachment shows. */
export const MAX_ATTACHMENT_TEXT_CHARS = 20_000

/** Renew an OAuth token this long before it runs out. */
export const OAUTH_REFRESH_MARGIN_MS = 60_000
