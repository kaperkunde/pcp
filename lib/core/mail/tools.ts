import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import type { MailKind } from "../servers"
import type { ToolAnnotations } from "../tools/define"
import {
  atLeastOne,
  defineInnerTool,
  exactlyOne,
  type ArgumentRule,
  type InnerTool,
} from "../tools/family"
import { parseRecipient, replyTarget, type RecipientObject } from "./addresses"
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_BULK_EMAILS,
  MAX_KEYWORD_CHARS,
  MAX_KEYWORDS,
  MAX_MAILBOX_NAME_CHARS,
  MAX_RECIPIENTS,
  MAX_SEARCH_LIMIT,
  MAX_SEND_ATTACHMENTS,
  MAX_SEARCH_OFFSET,
  MAX_SEARCH_TEXT_CHARS,
  MAX_SEND_TEXT_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_VACATION_SUBJECT_CHARS,
} from "./limits"

/**
 * The tools a mail account offers, the same for JMAP and IMAP where the
 * protocols allow, so an assistant learns one set. Which ones an account
 * has depends on its kind, on read-only, on whether it can send, and (JMAP)
 * on whether the server offers an automatic reply. Each is defined on PCP's
 * one tool interface (lib/core/tools/family.ts), its arguments checked by
 * the one validator before any connection is opened.
 *
 * It is a fixed set on purpose, not the protocol passed through: each tool
 * is one the rules can hold to (read-only, nothing deleted for good, files
 * as handles), so a JMAP method or IMAP command is reached only through a
 * tool written for it.
 */

export type MailToolName =
  | "list_mailboxes"
  | "search_emails"
  | "get_email"
  | "get_attachment"
  | "get_thread"
  | "list_identities"
  | "send_email"
  | "create_draft"
  | "move_email"
  | "mark_email"
  | "delete_email"
  | "create_mailbox"
  | "rename_mailbox"
  | "delete_mailbox"
  | "get_vacation_response"
  | "set_vacation_response"

type Annotations = ToolAnnotations

type MailToolInput = {
  name: MailToolName
  title: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: (kind: MailKind) => z.ZodObject<any>
  rules?: ArgumentRule[]
  /** Old argument names, accepted for a release with a note. */
  aliases?: Record<string, string>
  annotations: Annotations
  kinds: readonly MailKind[]
  /** Changes mail: absent on a read-only account, and refused there. */
  writes: boolean
  /** Sends text to others: only when the account can send. */
  sends?: boolean
  /** Only when the server offers an automatic reply (JMAP). */
  vacation?: boolean
}

const id = z
  .string()
  .min(1)
  .max(500)
  .describe("An email id, as search_emails returns it.")
const ids = z
  .array(id)
  .min(1)
  .max(MAX_BULK_EMAILS)
  .describe(
    `Several email ids, up to ${MAX_BULK_EMAILS}, in place of id: one call changes them all.`,
  )
const mailbox = z
  .string()
  .min(1)
  .max(500)
  .describe(
    "A mailbox: its id from list_mailboxes, a role (inbox, sent, drafts, trash, junk, archive), or its name or path (Clients/Acme).",
  )
const mailboxName = z
  .string()
  .min(1)
  .max(MAX_MAILBOX_NAME_CHARS)
  .regex(/^[^\u0000-\u001f\u007f/]+$/, {
    message:
      "A name without / or control characters; parent puts it inside another mailbox.",
  })
  .refine((value) => value.trim() === value, {
    message: "A name without spaces at either end.",
  })
/**
 * A keyword (label) as JMAP (RFC 8621 4.1.1) and IMAP both take one. The
 * ones read, flagged and answered set are left to those.
 */
const keyword = z
  .string()
  .min(1)
  .max(MAX_KEYWORD_CHARS)
  .regex(/^[!#$&'+,\-./0-9:;<=>?@A-Z[^_`a-z|}~]+$/, {
    message:
      'A keyword is printable ASCII without spaces or any of ( ) { ] % * " \\, like "invoices" or "$label1".',
  })
  .refine(
    (value) =>
      !["$seen", "$flagged", "$answered", "$draft"].includes(
        value.toLowerCase(),
      ),
    { message: "Use read, flagged or answered for that one." },
  )
const keywords = z.array(keyword).min(1).max(MAX_KEYWORDS)
/** One email or several: id or ids, never both. */
const ONE_OR_MANY = exactlyOne(
  ["id", "ids"],
  "Give id for one email, or ids for several.",
)
const date = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Give a date like 2026-10-01 or 2026-10-01T09:00:00Z.",
  })
/**
 * One recipient: written out, or as get_email and get_thread give one
 * ({name, email}), so an address read can be passed back as it is.
 */
const recipient = z.union([
  z.string().min(3).max(400),
  z.strictObject({
    name: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe("The name shown with the address; null or left out for none."),
    email: z.string().min(3).max(320).describe("The address."),
  }),
])
const RECIPIENTS =
  'Addresses, each as "ada@example.com", "Ada Lovelace <ada@example.com>", or {"name": "Ada Lovelace", "email": "ada@example.com"} as get_email gives them.'
const recipients = z.array(recipient).max(MAX_RECIPIENTS).describe(RECIPIENTS)
/** The email a reply answers: PCP's id for it, or its Message-ID. */
const replyTo = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => replyTarget(value) !== null, {
    message:
      "Give the email's id from search_emails, or its Message-ID, like <abc@example.com>.",
  })
  .describe(
    "The email this replies to: its id as search_emails returns it, or its Message-ID header (as get_email's messageId).",
  )
const noArgs = () => z.strictObject({})

/**
 * What send_email and create_draft take: the same email, so a draft can be
 * written as it would be sent. A draft may name nobody yet.
 */
function composition(kind: MailKind, { draft }: { draft: boolean }) {
  return z.strictObject({
    to: (draft ? recipients.optional() : recipients.min(1)).describe(
      draft
        ? `Who it goes to, when it is sent. ${RECIPIENTS}`
        : `Who it goes to. ${RECIPIENTS}`,
    ),
    cc: recipients.optional().describe("Who gets a copy, as to takes them."),
    bcc: recipients
      .optional()
      .describe("Who gets a copy no other recipient sees, as to takes them."),
    subject: z.string().max(MAX_SUBJECT_CHARS).describe("The subject line."),
    text: z.string().max(MAX_SEND_TEXT_CHARS).describe("The body, plain text."),
    in_reply_to: replyTo.optional(),
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
              draft
                ? "The identity id the draft is from (list_identities); the account's own by default."
                : "The identity id to send as (list_identities); the account's own by default.",
            ),
        }
      : {}),
  })
}

const READS: Annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

/** What send_email and create_draft took in camelCase until this release. */
const COMPOSE_ALIASES = { inReplyTo: "in_reply_to" }

const INPUTS: readonly MailToolInput[] = [
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
    description: `Finds emails in one mailbox (the inbox unless you name another), or with all_mailboxes in every mailbox but Trash and Junk, newest first. Every filter is optional; with none, it lists the latest emails. Answers with each email's id, date, sender, recipients, subject, flags, keywords and whether it has attachments; get_email reads one. Up to ${MAX_SEARCH_LIMIT} at a time; offset pages further.`,
    args: () =>
      z.strictObject({
        mailbox: mailbox.optional(),
        all_mailboxes: z
          .boolean()
          .optional()
          .describe(
            "true: search every mailbox but Trash and Junk instead of one (name Trash or Junk as mailbox to search those).",
          ),
        text: z
          .string()
          .min(1)
          .max(MAX_SEARCH_TEXT_CHARS)
          .optional()
          .describe("Words anywhere in the email: headers or body."),
        from: z
          .string()
          .min(1)
          .max(MAX_SEARCH_TEXT_CHARS)
          .optional()
          .describe("Words in the sender's name or address."),
        to: z
          .string()
          .min(1)
          .max(MAX_SEARCH_TEXT_CHARS)
          .optional()
          .describe("Words in a recipient's name or address."),
        subject: z
          .string()
          .min(1)
          .max(MAX_SEARCH_TEXT_CHARS)
          .optional()
          .describe("Words in the subject."),
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
        flagged: z
          .boolean()
          .optional()
          .describe("true: only flagged; false: only not flagged."),
        has_attachment: z
          .boolean()
          .optional()
          .describe("true: only emails with attachments; false: only without."),
        keyword: keyword
          .optional()
          .describe("Only emails with this keyword (label)."),
        not_keyword: keyword
          .optional()
          .describe("Only emails without this keyword (label)."),
        offset: z
          .number()
          .int()
          .min(0)
          .max(MAX_SEARCH_OFFSET)
          .optional()
          .describe("How many to skip, for the next page (0 by default)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`How many (default ${DEFAULT_SEARCH_LIMIT}).`),
      }),
    rules: [
      {
        says: "Name a mailbox, or say all_mailboxes, not both.",
        schema: {
          not: {
            required: ["all_mailboxes", "mailbox"],
            properties: { all_mailboxes: { const: true } },
          },
        },
      },
    ],
    aliases: {
      allMailboxes: "all_mailboxes",
      hasAttachment: "has_attachment",
      notKeyword: "not_keyword",
    },
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
      "Reads one attachment of an email and keeps it as a handle, to pass to another tool or to send_email or create_draft as an attachment. Text (plain text, CSV, JSON, XML, HTML, calendar files and the like) comes back as text too; any other file, such as an image or a PDF, only as the handle.",
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
        thread_id: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "The email's threadId, as search_emails or get_email gives it.",
          ),
      }),
    aliases: { threadId: "thread_id" },
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
      'Sends a plain-text email from this account. A copy goes into Sent, as the account is set: savedTo names the mailbox, is "pending" while PCP checks, once it has answered, whether the mail server filed a copy itself (it files one only when not), or is null when no copy is kept. To reply, pass the email you answer as in_reply_to, by its id or its Message-ID: the reply then joins its conversation, and that email is marked answered (answered in the result says whether it could be). To attach files, pass results PCP kept for you as attachments, [{"$result": "<id>"}]: an attachment get_attachment read (from this account or another), or any file a tool answered with. Sending cannot be undone.',
    args: (kind) => composition(kind, { draft: false }),
    aliases: COMPOSE_ALIASES,
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
    name: "create_draft",
    title: "Write a draft",
    description:
      'Writes a plain-text email into this account\'s Drafts mailbox, marked as a draft, and sends nothing: the owner can read it, change it and send it from their mail app. It takes what send_email takes, with recipients optional. To draft a reply, pass the email it answers as in_reply_to, by its id or its Message-ID: the draft then joins its conversation. To attach files, pass results PCP kept for you as attachments, [{"$result": "<id>"}]. Answers with the draft\'s id, which get_email reads, and the mailbox it is in.',
    args: (kind) => composition(kind, { draft: true }),
    aliases: COMPOSE_ALIASES,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
  {
    name: "move_email",
    title: "Move emails",
    description: `Moves an email, or up to ${MAX_BULK_EMAILS} with ids, to another mailbox. An IMAP email gets a new id when it moves: the answer gives it. With ids, the answer lists the emails moved (done) and the ones that could not be, with why (failed).`,
    args: () =>
      z.strictObject({
        id: id.optional(),
        ids: ids.optional(),
        mailbox: mailbox.describe(
          "Where to move it: an id from list_mailboxes, a role (inbox, archive, trash…), or a name or path.",
        ),
      }),
    rules: [ONE_OR_MANY],
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
    title: "Mark emails",
    description: `Marks an email, or up to ${MAX_BULK_EMAILS} with ids: read or unread, flagged or not, answered or not, and adds or removes keywords (labels, as other mail apps show them). What you leave out stays as it is. With ids, the answer lists the emails changed (done) and the ones that could not be, with why (failed).`,
    args: () =>
      z.strictObject({
        id: id.optional(),
        ids: ids.optional(),
        read: z.boolean().optional().describe("true: read; false: unread."),
        flagged: z
          .boolean()
          .optional()
          .describe("true: flagged; false: not flagged."),
        answered: z
          .boolean()
          .optional()
          .describe("true: answered; false: not answered."),
        add_keywords: keywords
          .optional()
          .describe('Keywords to add, like ["invoices"].'),
        remove_keywords: keywords.optional().describe("Keywords to remove."),
      }),
    rules: [
      ONE_OR_MANY,
      atLeastOne(
        ["read", "flagged", "answered", "add_keywords", "remove_keywords"],
        "Say what to change: read, flagged, answered, add_keywords or remove_keywords.",
      ),
    ],
    aliases: {
      addKeywords: "add_keywords",
      removeKeywords: "remove_keywords",
    },
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
    title: "Delete emails",
    description: `Moves an email, or up to ${MAX_BULK_EMAILS} with ids, to the Trash. Nothing is deleted for good; the owner can take them back from there. With ids, the answer lists the emails moved (done) and the ones that could not be, with why (failed).`,
    args: () => z.strictObject({ id: id.optional(), ids: ids.optional() }),
    rules: [ONE_OR_MANY],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
  {
    name: "create_mailbox",
    title: "Create a mailbox",
    description:
      "Creates a mailbox (folder), at the top or inside another one (parent). Answers with it as list_mailboxes would.",
    args: () =>
      z.strictObject({
        name: mailboxName.describe("The new mailbox's name."),
        parent: mailbox
          .optional()
          .describe(
            "The mailbox to put it inside (id, name or path); the top level by default.",
          ),
      }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
  {
    name: "rename_mailbox",
    title: "Rename or move a mailbox",
    description:
      "Gives a mailbox a new name, or moves it inside another one (parent; null for the top level), or both. The inbox stays where it is. On IMAP the emails inside get new ids, since an IMAP email's id says which mailbox it is in: search again for them.",
    args: () =>
      z.strictObject({
        mailbox,
        name: mailboxName.optional().describe("Its new name."),
        parent: mailbox
          .nullable()
          .optional()
          .describe(
            "The mailbox to move it inside (id, name or path), or null for the top level.",
          ),
      }),
    rules: [
      atLeastOne(["name", "parent"], "Say a new name, a new parent, or both."),
    ],
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
    name: "delete_mailbox",
    title: "Delete a mailbox",
    description:
      "Deletes an empty mailbox (folder) that has no mailboxes inside it. One that holds mail is refused (move or delete its emails first), and so are the inbox, Trash, Sent, Drafts and the account's other special mailboxes, so no mail is deleted for good.",
    args: () => z.strictObject({ mailbox }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    kinds: ["jmap", "imap"],
    writes: true,
  },
  {
    name: "get_vacation_response",
    title: "Read the automatic reply",
    description:
      "Reads the account's automatic reply (out of office): whether it is on, between which dates, and its subject and text.",
    args: noArgs,
    annotations: READS,
    kinds: ["jmap"],
    writes: false,
    vacation: true,
  },
  {
    name: "set_vacation_response",
    title: "Set the automatic reply",
    description:
      "Turns the account's automatic reply (out of office) on or off, and sets what it says and between which dates it answers. What you leave out stays as it is; null clears it. While it is on, the server sends this text to whoever writes to the account, and that cannot be undone.",
    args: () =>
      z.strictObject({
        enabled: z.boolean().describe("Whether the automatic reply is on."),
        from: date
          .nullable()
          .optional()
          .describe("When it starts answering (ISO 8601); null for now."),
        to: date
          .nullable()
          .optional()
          .describe("When it stops answering (ISO 8601); null for never."),
        subject: z
          .string()
          .max(MAX_VACATION_SUBJECT_CHARS)
          .nullable()
          .optional()
          .describe("The reply's subject; null for the server's own."),
        text: z
          .string()
          .max(MAX_SEND_TEXT_CHARS)
          .nullable()
          .optional()
          .describe("The reply's text, plain."),
      }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kinds: ["jmap"],
    writes: true,
    // The server sends the text to anyone who writes in: sending, as far as
    // the owner's levels and a read-only account go.
    sends: true,
    vacation: true,
  },
]

type MailToolSpec = Omit<MailToolInput, "args" | "rules" | "aliases"> & {
  /** The tool as an account of each kind it is offered on takes it. */
  tool: Partial<Record<MailKind, InnerTool>>
}

const SPECS: readonly MailToolSpec[] = INPUTS.map(
  ({ args, rules, aliases, ...spec }) => ({
    ...spec,
    tool: Object.fromEntries(
      spec.kinds.map((kind) => [
        kind,
        defineInnerTool({
          name: spec.name,
          title: spec.title,
          description: spec.description,
          input: args(kind),
          annotations: spec.annotations,
          ...(rules ? { rules } : {}),
          ...(aliases ? { aliases } : {}),
        }),
      ]),
    ),
  }),
)

const BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]))

export function mailToolSpec(name: string): MailToolSpec | undefined {
  return BY_NAME.get(name as MailToolName)
}

/** The tool an account of this kind offers by that name, if any. */
export function mailTool(kind: MailKind, name: string): InnerTool | undefined {
  return mailToolSpec(name)?.tool[kind]
}

/** The tools an account has, for the catalogue. */
export function mailTools({
  kind,
  readOnly,
  canSend,
  canVacation = false,
}: {
  kind: MailKind
  readOnly: boolean
  canSend: boolean
  /** JMAP: the session offers VacationResponse. */
  canVacation?: boolean
}): CatalogueTool[] {
  return SPECS.filter(
    (spec) =>
      spec.kinds.includes(kind) &&
      !(readOnly && spec.writes) &&
      !(spec.sends && !canSend) &&
      !(spec.vacation && !canVacation),
  ).map((spec) => spec.tool[kind]!.listed())
}

/** Recipients as parsed addresses; `field` (to, cc, bcc) names them in a refusal. */
export function parseRecipients(
  values: unknown,
  field: string,
): Array<{ name: string | null; email: string }> {
  return Array.isArray(values)
    ? values.map((value, index) =>
        parseRecipient(
          typeof value === "object" &&
            value !== null &&
            typeof (value as { email?: unknown }).email === "string"
            ? (value as RecipientObject)
            : String(value),
          `Recipient ${index + 1} in ${field}`,
        ),
      )
    : []
}

export type { MailToolSpec }
