import { randomUUID } from "node:crypto"

import { asBytes } from "../crypto"

import { describeFetchError, discard, readCapped } from "../openapi/http"
import { send } from "../openapi/transport"
import { PCP_VERSION } from "../version"
import { onSameOrigin } from "./addresses"
import { findMailbox, mailboxByRole } from "./mailboxes"
import { htmlToText } from "./html"
import {
  MAIL_CALL_TIMEOUT_MS,
  MAX_ATTACHMENTS_LISTED,
  MAX_JMAP_RESPONSE_BYTES,
  MAX_MAILBOXES,
  MAX_THREAD_EMAILS,
} from "./limits"
import { bareType, charsetOf } from "../media-types"
import {
  MAILBOX_ROLES,
  MailAuthError,
  MailRequestError,
  MailTransportError,
  type AttachmentContent,
  type MailAddress,
  type MailBackend,
  type MailboxRole,
  type MailboxSummary,
  type MailCredential,
  type MailIdentity,
  type MailMessageDetail,
  type MailMessageSummary,
  type MoveResult,
  type SearchQuery,
  type SearchResult,
  type SendInput,
  type SendResult,
} from "./types"

/**
 * A mail account on a JMAP server (RFC 8620, RFC 8621): Stalwart, Fastmail,
 * Cyrus, Apache James. PCP reads the session document at the address the
 * owner typed, then POSTs method calls to the API address it names, which
 * must be on the same origin so the credential goes nowhere the owner did
 * not choose. Redirects are never followed.
 *
 * A credential with onUnauthorized (OAuth) is renewed once when the server
 * refuses it; the new token's values are added to credential.redact, so
 * the caller keeps them out of answers too.
 */

const CORE = "urn:ietf:params:jmap:core"
const MAIL = "urn:ietf:params:jmap:mail"
const SUBMISSION = "urn:ietf:params:jmap:submission"

const USER_AGENT = `pcp/${PCP_VERSION}`

export type JmapSession = {
  apiUrl: string
  /** The download URL template, made absolute; null when none was named. */
  downloadUrl: string | null
  /** The upload URL template, made absolute; null when none was named. */
  uploadUrl: string | null
  accountId: string
  /** Whether this account may send. */
  submission: boolean
}

export type JmapConfig = JmapSession & {
  /** The From address to prefer among the identities. */
  from: string | null
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function where(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return "the mail server"
  }
}

/**
 * One HTTP exchange with the credential, renewing an OAuth token once if
 * the server refuses it. Answers with the response's status and body.
 */
async function exchange(
  url: string,
  init: {
    method: "GET" | "POST"
    /** JSON text, or bytes sent as `contentType` (an upload). */
    body?: string | Buffer
    contentType?: string
    accept?: string
  },
  credential: MailCredential,
  maxBytes = MAX_JMAP_RESPONSE_BYTES,
): Promise<{ status: number; bytes: Buffer; type: string }> {
  for (let attempt = 0; ; attempt++) {
    let response: Response

    try {
      response = await send(url, {
        method: init.method,
        headers: {
          accept: init.accept ?? "application/json",
          "user-agent": USER_AGENT,
          ...(init.body !== undefined
            ? {
                "content-type":
                  init.contentType ?? "application/json; charset=utf-8",
              }
            : {}),
          ...credential.headers,
        },
        body:
          init.body === undefined || typeof init.body === "string"
            ? init.body
            : asBytes(init.body),
        signal: AbortSignal.timeout(MAIL_CALL_TIMEOUT_MS),
      })
    } catch (error) {
      throw new MailTransportError(
        `${where(url)} could not be reached: ${describeFetchError(error, MAIL_CALL_TIMEOUT_MS)}`,
      )
    }

    if (response.status === 401) {
      await discard(response)
      const renewed =
        attempt === 0 && credential.onUnauthorized
          ? await credential.onUnauthorized()
          : null

      if (!renewed) {
        throw new MailAuthError(
          "The mail server refused the credentials PCP sent.",
        )
      }

      credential.headers = renewed.headers
      credential.redact.push(...renewed.redact)
      continue
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      await discard(response)
      const target = location ? where(new URL(location, url).toString()) : null

      throw new MailTransportError(
        `${where(url)} answered with a redirect${target ? ` to ${target}` : ""}. PCP does not follow redirects: enter that address instead.`,
      )
    }

    let body: { bytes: Buffer; truncated: boolean }

    try {
      body = await readCapped(response, maxBytes)
    } catch (error) {
      throw new MailTransportError(
        `${where(url)} stopped answering: ${describeFetchError(error, MAIL_CALL_TIMEOUT_MS)}`,
      )
    }

    if (body.truncated) {
      throw new MailRequestError(
        `The mail server's answer is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, more than PCP reads.`,
      )
    }

    return {
      status: response.status,
      bytes: body.bytes,
      type: response.headers.get("content-type") ?? "",
    }
  }
}

function parseJson(bytes: Buffer, what: string): Json {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown

    if (isObject(value)) {
      return value
    }
  } catch {
    // Said below.
  }

  throw new MailTransportError(`${what} is not JSON; is this a JMAP server?`)
}

function excerpt(bytes: Buffer): string {
  const text = bytes.toString("utf8").replace(/\s+/g, " ").trim()
  return text ? `: ${text.slice(0, 300)}` : ""
}

/** The session document: where the API is, and which account is mail. */
export async function fetchJmapSession(
  sessionUrl: string,
  credential: MailCredential,
): Promise<JmapSession> {
  const { status, bytes } = await exchange(
    sessionUrl,
    { method: "GET" },
    credential,
  )

  if (status < 200 || status >= 300) {
    throw new MailTransportError(
      `${where(sessionUrl)} answered HTTP ${status}${excerpt(bytes)}. The session URL is usually https://<server>/.well-known/jmap.`,
    )
  }

  const session = parseJson(bytes, "The session document")
  const capabilities = isObject(session.capabilities)
    ? session.capabilities
    : {}
  const primary = isObject(session.primaryAccounts)
    ? session.primaryAccounts
    : {}
  const accountId = primary[MAIL]

  if (!(MAIL in capabilities) || typeof accountId !== "string" || !accountId) {
    throw new MailTransportError(
      "The JMAP server does not offer mail to this account.",
    )
  }

  if (typeof session.apiUrl !== "string") {
    throw new MailTransportError("The session document names no API address.")
  }

  const apiUrl = onSameOrigin(session.apiUrl, sessionUrl)

  if (!apiUrl) {
    throw new MailTransportError(
      `The session names its API at ${where(new URL(session.apiUrl, sessionUrl).toString())}, another address than the one you entered. PCP only sends the credential where you chose: enter a session URL on that address.`,
    )
  }

  const accounts = isObject(session.accounts) ? session.accounts : {}
  const account = isObject(accounts[accountId]) ? accounts[accountId] : {}
  const accountCapabilities = isObject(account.accountCapabilities)
    ? account.accountCapabilities
    : null

  return {
    apiUrl,
    downloadUrl:
      typeof session.downloadUrl === "string"
        ? downloadTemplate(session.downloadUrl, sessionUrl)
        : null,
    uploadUrl:
      typeof session.uploadUrl === "string"
        ? downloadTemplate(session.uploadUrl, sessionUrl)
        : null,
    accountId,
    submission:
      SUBMISSION in capabilities &&
      (accountCapabilities === null || SUBMISSION in accountCapabilities),
  }
}

/**
 * A download or upload template made absolute, when it is on the session's
 * origin. Its {variables} are kept as they are; they are filled per use.
 */
function downloadTemplate(template: string, sessionUrl: string): string | null {
  const probe = template.replace(/\{[^{}]*\}/g, "x")

  if (!onSameOrigin(probe, sessionUrl)) {
    return null
  }

  return /^[a-z][a-z0-9+.-]*:/i.test(template)
    ? template
    : `${new URL(sessionUrl).origin}${template.startsWith("/") ? "" : "/"}${template}`
}

type MethodCall = [string, Json, string]
type MethodResponse = [string, Json, string]

/** One JMAP request: its method calls, answered by call id. */
export async function jmapRequest(
  apiUrl: string,
  credential: MailCredential,
  calls: MethodCall[],
  using: string[] = [CORE, MAIL],
): Promise<Map<string, Json>> {
  const { status, bytes } = await exchange(
    apiUrl,
    { method: "POST", body: JSON.stringify({ using, methodCalls: calls }) },
    credential,
  )

  if (status >= 500) {
    throw new MailTransportError(
      `The mail server failed (HTTP ${status})${excerpt(bytes)}`,
    )
  }

  if (status < 200 || status >= 300) {
    // A request-level problem (RFC 8620 3.6.1): this request, not the account.
    const problem = (() => {
      try {
        const value = JSON.parse(bytes.toString("utf8")) as Json
        return [value.type, value.detail].filter(Boolean).join(": ")
      } catch {
        return ""
      }
    })()

    throw new MailRequestError(
      `The mail server refused the request (HTTP ${status})${problem ? `: ${String(problem).slice(0, 300)}` : excerpt(bytes)}`,
    )
  }

  const answer = parseJson(bytes, "The mail server's answer")
  const responses = Array.isArray(answer.methodResponses)
    ? (answer.methodResponses as unknown[])
    : []
  const byId = new Map<string, Json>()

  for (const entry of responses) {
    if (!Array.isArray(entry) || entry.length < 3) {
      continue
    }

    const [name, args, id] = entry as MethodResponse

    if (name === "error") {
      const call = calls.find((candidate) => candidate[2] === id)
      const type = typeof args?.type === "string" ? args.type : "an error"
      const description =
        typeof args?.description === "string" ? `: ${args.description}` : ""

      throw new MailRequestError(
        `${call?.[0] ?? "A JMAP method"} failed with ${type}${description.slice(0, 300)}`,
      )
    }

    if (isObject(args) && typeof id === "string") {
      byId.set(id, args)
    }
  }

  return byId
}

function answerOf(answers: Map<string, Json>, id: string): Json {
  const answer = answers.get(id)

  if (!answer) {
    throw new MailTransportError("The mail server left a method unanswered.")
  }

  return answer
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function addresses(value: unknown): MailAddress[] {
  return list(value).flatMap((item) =>
    typeof item.email === "string"
      ? [
          {
            name: typeof item.name === "string" && item.name ? item.name : null,
            email: item.email,
          },
        ]
      : [],
  )
}

function role(value: unknown): MailboxRole | null {
  return typeof value === "string" &&
    (MAILBOX_ROLES as readonly string[]).includes(value.toLowerCase())
    ? (value.toLowerCase() as MailboxRole)
    : null
}

const SUMMARY_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "receivedAt",
  "from",
  "to",
  "cc",
  "subject",
  "preview",
  "keywords",
  "hasAttachment",
  "size",
]

function summary(email: Json): MailMessageSummary {
  const keywords = isObject(email.keywords) ? email.keywords : {}

  return {
    id: String(email.id),
    threadId: typeof email.threadId === "string" ? email.threadId : null,
    mailboxIds: isObject(email.mailboxIds)
      ? Object.entries(email.mailboxIds).flatMap(([key, on]) =>
          on === true ? [key] : [],
        )
      : [],
    date: typeof email.receivedAt === "string" ? email.receivedAt : null,
    from: addresses(email.from),
    to: addresses(email.to),
    cc: addresses(email.cc),
    subject: typeof email.subject === "string" ? email.subject : "",
    preview: typeof email.preview === "string" ? email.preview : "",
    flags: {
      unread: keywords.$seen !== true,
      flagged: keywords.$flagged === true,
      answered: keywords.$answered === true,
      draft: keywords.$draft === true,
    },
    hasAttachments: email.hasAttachment === true,
    size: typeof email.size === "number" ? email.size : null,
  }
}

/** A UTCDate (RFC 8620 1.4): no fractional seconds when they are zero. */
function utcDate(value: string): string {
  return new Date(Date.parse(value)).toISOString().replace(".000Z", "Z")
}

export function openJmapBackend(
  config: JmapConfig,
  credential: MailCredential,
): MailBackend {
  const { apiUrl, accountId } = config

  const request = (calls: MethodCall[], using?: string[]) =>
    jmapRequest(apiUrl, credential, calls, using)

  async function mailboxes(): Promise<MailboxSummary[]> {
    const answers = await request([
      [
        "Mailbox/get",
        {
          accountId,
          properties: [
            "id",
            "name",
            "parentId",
            "role",
            "totalEmails",
            "unreadEmails",
          ],
        },
        "m",
      ],
    ])

    return list(answerOf(answers, "m").list)
      .slice(0, MAX_MAILBOXES)
      .map((box) => ({
        id: String(box.id),
        name: typeof box.name === "string" ? box.name : String(box.id),
        path: null,
        role: role(box.role),
        parentId: typeof box.parentId === "string" ? box.parentId : null,
        totalEmails:
          typeof box.totalEmails === "number" ? box.totalEmails : null,
        unreadEmails:
          typeof box.unreadEmails === "number" ? box.unreadEmails : null,
      }))
  }

  async function summaries(ids: string[]): Promise<MailMessageSummary[]> {
    if (ids.length === 0) {
      return []
    }

    const answers = await request([
      ["Email/get", { accountId, ids, properties: SUMMARY_PROPERTIES }, "g"],
    ])
    const found = new Map(
      list(answerOf(answers, "g").list).map((email) => [
        String(email.id),
        summary(email),
      ]),
    )

    return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []))
  }

  async function setEmail(id: string, patch: Json): Promise<void> {
    const answers = await request([
      ["Email/set", { accountId, update: { [id]: patch } }, "s"],
    ])
    const notUpdated = answerOf(answers, "s").notUpdated

    if (isObject(notUpdated) && notUpdated[id]) {
      const error = isObject(notUpdated[id]) ? notUpdated[id] : {}
      throw new MailRequestError(
        error.type === "notFound"
          ? "No email with that id."
          : `The mail server did not change the email: ${String(error.type ?? "")}${error.description ? ` (${String(error.description).slice(0, 200)})` : ""}`,
      )
    }
  }

  async function move(id: string, target: MailboxSummary): Promise<MoveResult> {
    await setEmail(id, { mailboxIds: { [target.id]: true } })
    return { id, previousId: id, mailboxId: target.id }
  }

  return {
    listMailboxes: mailboxes,

    async searchEmails(query: SearchQuery): Promise<SearchResult> {
      const boxes = await mailboxes()
      const box = query.mailbox
        ? findMailbox(boxes, query.mailbox)
        : (mailboxByRole(boxes, "inbox") ?? findMailbox(boxes, "inbox"))
      const conditions: Json[] = [{ inMailbox: box.id }]

      for (const key of ["text", "from", "to", "subject"] as const) {
        if (query[key]) {
          conditions.push({ [key]: query[key] })
        }
      }

      if (query.after) conditions.push({ after: utcDate(query.after) })
      if (query.before) conditions.push({ before: utcDate(query.before) })
      if (query.unread === true) conditions.push({ notKeyword: "$seen" })
      if (query.unread === false) conditions.push({ hasKeyword: "$seen" })
      if (query.flagged === true) conditions.push({ hasKeyword: "$flagged" })
      if (query.flagged === false) conditions.push({ notKeyword: "$flagged" })
      if (query.hasAttachment !== undefined) {
        conditions.push({ hasAttachment: query.hasAttachment })
      }

      const answers = await request([
        [
          "Email/query",
          {
            accountId,
            filter:
              conditions.length === 1
                ? conditions[0]
                : { operator: "AND", conditions },
            sort: [{ property: "receivedAt", isAscending: false }],
            position: query.offset,
            limit: query.limit,
            calculateTotal: true,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: SUMMARY_PROPERTIES,
          },
          "g",
        ],
      ])
      const queried = answerOf(answers, "q")
      const ids = strings(queried.ids)
      const found = new Map(
        list(answerOf(answers, "g").list).map((email) => [
          String(email.id),
          summary(email),
        ]),
      )

      return {
        emails: ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : [])),
        total: typeof queried.total === "number" ? queried.total : null,
        offset: query.offset,
      }
    },

    async getEmail(id, { bodyBytes }): Promise<MailMessageDetail> {
      const answers = await request([
        [
          "Email/get",
          {
            accountId,
            ids: [id],
            properties: [
              ...SUMMARY_PROPERTIES,
              "bcc",
              "replyTo",
              "messageId",
              "inReplyTo",
              "references",
              "textBody",
              "attachments",
              "bodyValues",
            ],
            bodyProperties: [
              "partId",
              "blobId",
              "size",
              "name",
              "type",
              "charset",
            ],
            fetchTextBodyValues: true,
            maxBodyValueBytes: bodyBytes,
          },
          "g",
        ],
      ])
      const [email] = list(answerOf(answers, "g").list)

      if (!email) {
        throw new MailRequestError("No email with that id.")
      }

      const values = isObject(email.bodyValues) ? email.bodyValues : {}
      const parts = list(email.textBody)
      let truncated = false
      let source: "text" | "html" | "none" = "none"
      const texts = parts.map((part) => {
        const value = isObject(values[String(part.partId)])
          ? (values[String(part.partId)] as Json)
          : {}
        truncated ||= value.isTruncated === true
        const raw = typeof value.value === "string" ? value.value : ""

        if (bareType(String(part.type ?? "")) === "text/html") {
          source = source === "text" ? "text" : "html"
          return htmlToText(raw).text
        }

        source = "text"
        return raw
      })

      return {
        ...summary(email),
        bcc: addresses(email.bcc),
        replyTo: addresses(email.replyTo),
        messageId: strings(email.messageId)[0] ?? null,
        inReplyTo: strings(email.inReplyTo),
        references: strings(email.references),
        body: { text: texts.join("\n\n"), source, truncated },
        attachments: list(email.attachments)
          .slice(0, MAX_ATTACHMENTS_LISTED)
          .map((part) => ({
            id: String(part.blobId),
            name: typeof part.name === "string" ? part.name : null,
            type:
              typeof part.type === "string"
                ? part.type
                : "application/octet-stream",
            size: typeof part.size === "number" ? part.size : null,
          })),
      }
    },

    async getThread(threadId): Promise<MailMessageSummary[]> {
      const answers = await request([
        ["Thread/get", { accountId, ids: [threadId] }, "t"],
      ])
      const [thread] = list(answerOf(answers, "t").list)

      if (!thread) {
        throw new MailRequestError("No conversation with that id.")
      }

      return summaries(strings(thread.emailIds).slice(-MAX_THREAD_EMAILS))
    },

    async listIdentities(): Promise<MailIdentity[]> {
      const answers = await request(
        [["Identity/get", { accountId }, "i"]],
        [CORE, MAIL, SUBMISSION],
      )

      return list(answerOf(answers, "i").list).map((identity) => ({
        id: String(identity.id),
        name: typeof identity.name === "string" ? identity.name : "",
        email: typeof identity.email === "string" ? identity.email : "",
      }))
    },

    async sendEmail(input: SendInput): Promise<SendResult> {
      if (!config.submission) {
        throw new MailRequestError("This account cannot send mail.")
      }

      const first = await request(
        [
          [
            "Mailbox/get",
            { accountId, properties: ["id", "name", "role"] },
            "m",
          ],
          ["Identity/get", { accountId }, "i"],
          ...(input.inReplyTo
            ? ([
                [
                  "Email/get",
                  {
                    accountId,
                    ids: [input.inReplyTo],
                    properties: ["messageId", "references"],
                  },
                  "r",
                ],
              ] as MethodCall[])
            : []),
        ],
        [CORE, MAIL, SUBMISSION],
      )
      const boxes = list(answerOf(first, "m").list)
      const drafts = boxes.find((box) => role(box.role) === "drafts")
      const sent = boxes.find((box) => role(box.role) === "sent")
      const identities = list(answerOf(first, "i").list)
      const wantedFrom = config.from?.toLowerCase()
      const identity = input.identity
        ? identities.find((candidate) => candidate.id === input.identity)
        : (identities.find(
            (candidate) =>
              typeof candidate.email === "string" &&
              candidate.email.toLowerCase() === wantedFrom,
          ) ?? identities[0])

      if (!identity || typeof identity.email !== "string") {
        throw new MailRequestError(
          input.identity
            ? "No identity with that id; list_identities lists them."
            : "This account has no identity to send as.",
        )
      }

      const home = drafts ?? sent

      if (!home) {
        throw new MailRequestError(
          "This account has no Drafts or Sent mailbox to send from.",
        )
      }

      let inReplyTo: string[] = []
      let references: string[] = []

      if (input.inReplyTo) {
        const [original] = list(answerOf(first, "r").list)

        if (!original) {
          throw new MailRequestError("No email with the id given as inReplyTo.")
        }

        inReplyTo = strings(original.messageId).slice(0, 1)
        references = [...strings(original.references), ...inReplyTo].slice(-20)
      }

      const domain = identity.email.split("@")[1] ?? "pcp.invalid"
      const messageId = `${randomUUID()}@${domain}`
      const from: MailAddress = {
        name:
          typeof identity.name === "string" && identity.name
            ? identity.name
            : null,
        email: identity.email,
      }
      const onSuccess: Json = { "keywords/$draft": null }
      // Uploaded first: a failed upload leaves nothing behind to clean up.
      const attached: Json[] = []

      for (const attachment of input.attachments ?? []) {
        const blob = await upload(attachment)
        attached.push({
          blobId: blob.blobId,
          type: blob.type ?? attachment.type,
          name: attachment.name,
          disposition: "attachment",
        })
      }

      if (drafts && sent) {
        onSuccess[`mailboxIds/${String(drafts.id)}`] = null
        onSuccess[`mailboxIds/${String(sent.id)}`] = true
      }

      const answers = await request(
        [
          [
            "Email/set",
            {
              accountId,
              create: {
                draft: {
                  mailboxIds: { [String(home.id)]: true },
                  keywords: { $draft: true, $seen: true },
                  from: [from],
                  to: input.to,
                  ...(input.cc.length ? { cc: input.cc } : {}),
                  ...(input.bcc.length ? { bcc: input.bcc } : {}),
                  subject: input.subject,
                  messageId: [messageId],
                  ...(inReplyTo.length ? { inReplyTo, references } : {}),
                  bodyValues: { body: { value: input.text } },
                  textBody: [{ partId: "body", type: "text/plain" }],
                  ...(attached.length ? { attachments: attached } : {}),
                },
              },
            },
            "e",
          ],
          [
            "EmailSubmission/set",
            {
              accountId,
              create: {
                send: { identityId: String(identity.id), emailId: "#draft" },
              },
              onSuccessUpdateEmail: { "#send": onSuccess },
            },
            "s",
          ],
        ],
        [CORE, MAIL, SUBMISSION],
      )
      const created = answerOf(answers, "e")
      const draft = isObject(created.created) ? created.created.draft : null

      if (!isObject(draft)) {
        const error = isObject(created.notCreated)
          ? created.notCreated.draft
          : null
        throw new MailRequestError(
          `The mail server did not take the email: ${describeSetError(error)}`,
        )
      }

      const submitted = answerOf(answers, "s")

      if (!isObject(submitted.created) || !submitted.created.send) {
        const error = isObject(submitted.notCreated)
          ? submitted.notCreated.send
          : null
        throw new MailRequestError(
          `The mail server did not send the email (it is left in ${String(home.name ?? "Drafts")}): ${describeSetError(error)}`,
        )
      }

      return {
        id: typeof draft.id === "string" ? draft.id : null,
        messageId,
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        savedTo: sent ? String(sent.name ?? "Sent") : String(home.name ?? ""),
      }
    },

    async moveEmail(id, mailbox): Promise<MoveResult> {
      return move(id, findMailbox(await mailboxes(), mailbox))
    },

    async markEmail(id, flags): Promise<MailMessageSummary> {
      const patch: Json = {}

      if (flags.read !== undefined) patch["keywords/$seen"] = flags.read || null
      if (flags.flagged !== undefined) {
        patch["keywords/$flagged"] = flags.flagged || null
      }

      await setEmail(id, patch)
      const [changed] = await summaries([id])

      if (!changed) {
        throw new MailRequestError("No email with that id.")
      }

      return changed
    },

    async deleteEmail(id): Promise<MoveResult> {
      const trash = mailboxByRole(await mailboxes(), "trash")

      if (!trash) {
        throw new MailRequestError(
          "This account has no Trash mailbox, and PCP never deletes an email for good.",
        )
      }

      return move(id, trash)
    },

    async getAttachment(
      id,
      attachment,
      { maxBytes },
    ): Promise<AttachmentContent> {
      const answers = await request([
        [
          "Email/get",
          {
            accountId,
            ids: [id],
            properties: ["attachments"],
            bodyProperties: ["blobId", "size", "name", "type", "charset"],
          },
          "g",
        ],
      ])
      const [email] = list(answerOf(answers, "g").list)

      if (!email) {
        throw new MailRequestError("No email with that id.")
      }

      const part = list(email.attachments).find(
        (candidate) => candidate.blobId === attachment,
      )

      if (!part) {
        throw new MailRequestError(
          "That email has no attachment with that id; get_email lists them.",
        )
      }

      const type =
        typeof part.type === "string" ? part.type : "application/octet-stream"
      const name = typeof part.name === "string" ? part.name : null
      const size = typeof part.size === "number" ? part.size : 0
      const meta = { name, type, size }

      const downloaded = await download(part, meta, maxBytes)

      return { ...meta, size: downloaded.bytes.length, ...downloaded }
    },

    async close() {
      // Nothing stays open between requests.
    },
  }

  /** One attachment to send, uploaded as a blob; its id and type. */
  async function upload(attachment: {
    name: string
    type: string
    bytes: Buffer
  }): Promise<{ blobId: string; type: string | null }> {
    if (!config.uploadUrl) {
      throw new MailRequestError(
        "This JMAP server offers no uploads, so PCP cannot send attachments from it.",
      )
    }

    const url = config.uploadUrl.replace(/\{(\w+)\}/g, (_, name: string) =>
      name === "accountId" ? encodeURIComponent(accountId) : "",
    )

    if (!onSameOrigin(url, apiUrl)) {
      throw new MailRequestError(
        "The upload address is not on the mail server.",
      )
    }

    const { status, bytes } = await exchange(
      url,
      { method: "POST", body: attachment.bytes, contentType: attachment.type },
      credential,
    )

    if (status < 200 || status >= 300) {
      throw new MailRequestError(
        `The mail server did not take the attachment ${attachment.name} (HTTP ${status}); nothing was sent.`,
      )
    }

    const answer = parseJson(bytes, "The upload answer")

    if (typeof answer.blobId !== "string" || answer.blobId === "") {
      throw new MailRequestError(
        "The mail server's upload answer names no blob; nothing was sent.",
      )
    }

    return {
      blobId: answer.blobId,
      type: typeof answer.type === "string" ? answer.type : null,
    }
  }

  /** The attachment's bytes, when it is small enough. */
  async function download(
    part: Json,
    meta: { name: string | null; type: string; size: number },
    maxBytes: number,
  ): Promise<{ bytes: Buffer; charset: string | null }> {
    if (!config.downloadUrl) {
      throw new MailRequestError("The JMAP server offers no downloads.")
    }

    if (meta.size > maxBytes) {
      throw new MailRequestError(
        `That attachment is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, more than PCP reads.`,
      )
    }

    const url = config.downloadUrl.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value =
        name === "accountId"
          ? accountId
          : name === "blobId"
            ? String(part.blobId)
            : name === "type"
              ? bareType(meta.type)
              : name === "name"
                ? (meta.name ?? "attachment")
                : ""
      return encodeURIComponent(value)
    })

    if (!onSameOrigin(url, apiUrl)) {
      throw new MailRequestError(
        "The download address is not on the mail server.",
      )
    }

    const { status, bytes } = await exchange(
      url,
      { method: "GET", accept: "*/*" },
      credential,
      maxBytes,
    )

    if (status < 200 || status >= 300) {
      throw new MailRequestError(
        `The mail server did not hand over the attachment (HTTP ${status}).`,
      )
    }

    const charset =
      (typeof part.charset === "string" ? part.charset : null) ??
      charsetOf(meta.type)

    return { bytes, charset }
  }
}

function describeSetError(error: unknown): string {
  if (!isObject(error)) {
    return "no reason given"
  }

  return [error.type, error.description]
    .filter((value) => typeof value === "string" && value)
    .join(": ")
    .slice(0, 300)
}
