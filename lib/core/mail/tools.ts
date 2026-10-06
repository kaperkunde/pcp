import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import { invalid } from "../errors"
import type { MailKind } from "../servers"
import { parseRecipient } from "./addresses"
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_RECIPIENTS,
  MAX_SEARCH_LIMIT,
  MAX_SEND_ATTACHMENTS,
  MAX_SEARCH_OFFSET,
  MAX_SEARCH_TEXT_CHARS,
  MAX_SEND_TEXT_CHARS,
  MAX_SUBJECT_CHARS,
} from "./limits"

/**
 * The tools a mail account offers, the same for JMAP and IMAP where the
 * protocols allow, so an assistant learns one set. Which ones an account
 * has depends on its kind, on read-only, and on whether it can send.
 * Arguments are checked here, before any connection is opened.
 */

export type MailToolName =
  | "list_mailboxes"
  | "search_emails"
  | "get_email"
  | "get_attachment"
  | "get_thread"
  | "list_identities"
  | "send_email"
  | "move_email"
  | "mark_email"
  | "delete_email"

type Annotations = {
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint: boolean
}

type MailToolSpec = {
  name: MailToolName
  title: string
  description: string
  args: (kind: MailKind) => z.ZodType
  annotations: Annotations
  kinds: readonly MailKind[]
  /** Changes mail: absent on a read-only account, and refused there. */
  writes: boolean
  /** Only when the account can send. */
  sends?: boolean
}

const id = z
  .string()
  .min(1)
  .max(500)
  .describe("An email id, as search_emails returns it.")
const mailbox = z
  .string()
  .min(1)
  .max(500)
  .describe(
    "A mailbox id from list_mailboxes, or a role: inbox, sent, drafts, trash, junk, archive.",
  )
const date = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Give a date like 2026-10-01 or 2026-10-01T09:00:00Z.",
  })
const recipients = z
  .array(z.string().min(3).max(400))
  .max(MAX_RECIPIENTS)
  .describe(
    'Addresses, as "ada@example.com" or "Ada Lovelace <ada@example.com>".',
  )
const noArgs = () => z.strictObject({})

const READS: Annotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
}

const SPECS: readonly MailToolSpec[] = [
  {
    name: "list_mailboxes",
    title: "List mailboxes",
    description:
      "Lists the mailboxes (folders) in this mail account with their ids, roles (inbox, sent, trash…) and how many emails and unread emails each holds.",
    args: noArgs,
    annotations: READS,
    kinds: ["jmap", "imap"],
    writes: false,
  },
  {
    name: "search_emails",
    title: "Search emails",
    description: `Finds emails in one mailbox (the inbox unless you name another), newest first. Every filter is optional; with none, it lists the latest emails. Answers with each email's id, date, sender, recipients, subject, flags and whether it has attachments; get_email reads one. Up to ${MAX_SEARCH_LIMIT} at a time; offset pages further.`,
    args: () =>
      z.strictObject({
        mailbox: mailbox.optional(),
        text: z
          .string()
          .min(1)
          .max(MAX_SEARCH_TEXT_CHARS)
          .optional()
          .describe("Words anywhere in the email: headers or body."),
        from: z.string().min(1).max(MAX_SEARCH_TEXT_CHARS).optional(),
        to: z.string().min(1).max(MAX_SEARCH_TEXT_CHARS).optional(),
        subject: z.string().min(1).max(MAX_SEARCH_TEXT_CHARS).optional(),
        after: date
          .optional()
          .describe("Only emails received on or after this date (ISO 8601)."),
        before: date
          .optional()
          .describe("Only emails received before this date (ISO 8601)."),
        unread: z
          .boolean()
          .optional()
          .describe("true: only unread; false: only read."),
        flagged: z.boolean().optional(),
        hasAttachment: z.boolean().optional(),
        offset: z.number().int().min(0).max(MAX_SEARCH_OFFSET).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`How many (default ${DEFAULT_SEARCH_LIMIT}).`),
      }),
    annotations: READS,
    kinds: ["jmap", "imap"],
    writes: false,
  },
  {
    name: "get_email",
    title: "Read an email",
    description:
      "Reads one email: its headers, its text (the HTML version made plain when there is no text one) and the list of its attachments. A long body is kept whole: body.result names it for read_result.",
    args: () => z.strictObject({ id }),
    annotations: READS,
    kinds: ["jmap", "imap"],
    writes: false,
  },
  {
    name: "get_attachment",
    title: "Read an attachment",
    description:
      "Reads one text attachment of an email (plain text, CSV, JSON, XML, HTML, calendar files and the like). Other kinds, such as images and PDFs, are described, not returned.",
    args: () =>
      z.strictObject({
        id,
        attachment: z
          .string()
          .min(1)
          .max(500)
          .describe("The attachment's id, from get_email's attachments."),
      }),
    annotations: READS,
    kinds: ["jmap", "imap"],
    writes: false,
  },
  {
    name: "get_thread",
    title: "Read a conversation",
    description:
      "Lists the emails in one conversation, oldest first, from the threadId search_emails or get_email gives.",
    args: () =>
      z.strictObject({
        threadId: z.string().min(1).max(500).describe("The email's threadId."),
      }),
    annotations: READS,
    kinds: ["jmap"],
    writes: false,
  },
  {
    name: "list_identities",
    title: "List sending identities",
    description:
      "Lists the addresses this account may send as. send_email takes one's id as identity.",
    args: noArgs,
    annotations: READS,
    kinds: ["jmap"],
    writes: false,
    sends: true,
  },
  {
    name: "send_email",
    title: "Send an email",
    description:
      'Sends a plain-text email from this account, and keeps a copy in Sent. To reply, pass the id of the email you answer as inReplyTo: the reply then joins its conversation, and that email is marked answered (answered in the result says whether it could be). To attach files, pass results PCP kept for you as attachments, [{"$result": "<id>"}]: an attachment get_attachment read (from this account or another), or any file a tool answered with. Sending cannot be undone.',
    args: (kind) =>
      z.strictObject({
        to: recipients.min(1),
        cc: recipients.optional(),
        bcc: recipients.optional(),
        subject: z.string().max(MAX_SUBJECT_CHARS),
        text: z
          .string()
          .max(MAX_SEND_TEXT_CHARS)
          .describe("The body, plain text."),
        inReplyTo: id
          .optional()
          .describe("The id of the email this answers, from search_emails."),
        attachments: z
          .array(
            z.strictObject({
              $result: z
                .string()
                .min(1)
                .max(64)
                .describe("A kept result's id, from its handle."),
              name: z
                .string()
                .min(1)
                .max(255)
                .regex(/^[^\u0000-\u001f\u007f/\\]+$/, {
                  message: "A file name, without a path or control characters.",
                })
                .optional()
                .describe("The file's name; the kept result's own by default."),
              type: z
                .string()
                .max(200)
                .regex(/^[\w.+-]+\/[\w.+-]+$/, {
                  message: "A media type, like application/pdf.",
                })
                .optional()
                .describe("Its media type; the kept result's own by default."),
            }),
          )
          .max(MAX_SEND_ATTACHMENTS)
          .optional()
          .describe(
            'Files to attach: kept results, as {"$result": "<id>"} with an optional name and type.',
          ),
        ...(kind === "jmap"
          ? {
              identity: z
                .string()
                .min(1)
                .max(500)
                .optional()
                .describe(
                  "The identity id to send as (list_identities); the account's own by default.",
                ),
            }
          : {}),
      }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
    sends: true,
  },
  {
    name: "move_email",
    title: "Move an email",
    description:
      "Moves an email to another mailbox. An IMAP email gets a new id when it moves: the answer gives it.",
    args: () => z.strictObject({ id, mailbox }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
  {
    name: "mark_email",
    title: "Mark an email",
    description: "Marks an email read or unread, flagged or not.",
    args: () =>
      z
        .strictObject({
          id,
          read: z.boolean().optional(),
          flagged: z.boolean().optional(),
        })
        .refine(
          (value) => value.read !== undefined || value.flagged !== undefined,
          {
            message: "Say read, flagged, or both.",
          },
        ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
  {
    name: "delete_email",
    title: "Delete an email",
    description:
      "Moves an email to the Trash. It is not deleted for good; the owner can take it back from there.",
    args: () => z.strictObject({ id }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
]

const BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]))

export function mailToolSpec(name: string): MailToolSpec | undefined {
  return BY_NAME.get(name as MailToolName)
}

function jsonSchema(schema: z.ZodType): unknown {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>
  delete generated.$schema
  return generated
}

/** The tools an account has, for the catalogue. */
export function mailTools({
  kind,
  readOnly,
  canSend,
}: {
  kind: MailKind
  readOnly: boolean
  canSend: boolean
}): CatalogueTool[] {
  return SPECS.filter(
    (spec) =>
      spec.kinds.includes(kind) &&
      !(readOnly && spec.writes) &&
      !(spec.sends && !canSend),
  ).map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: jsonSchema(spec.args(kind)),
    annotations: spec.annotations,
  }))
}

/** A tool's arguments, checked; a readable refusal otherwise. */
export function parseMailArgs(
  spec: MailToolSpec,
  kind: MailKind,
  args: unknown,
): Record<string, unknown> {
  const parsed = spec.args(kind).safeParse(args ?? {})

  if (!parsed.success) {
    throw invalid(
      `${spec.name}: ${z
        .prettifyError(parsed.error)
        .replace(/\s*\n\s*/g, " ")
        .slice(0, 500)}`,
    )
  }

  return parsed.data as Record<string, unknown>
}

/** Recipients as parsed addresses. */
export function parseRecipients(
  values: unknown,
): Array<{ name: string | null; email: string }> {
  return Array.isArray(values)
    ? values.map((value) => parseRecipient(String(value)))
    : []
}

export type { MailToolSpec }
