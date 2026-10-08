import { randomUUID } from "node:crypto"

import { asBytes } from "../crypto"

import { describeFetchError, discard, readCapped } from "../openapi/http"
import { send } from "../openapi/transport"
import { PCP_VERSION } from "../version"
import { onSameOrigin } from "./addresses"
import {
  checkDeletable,
  checkNewParent,
  draftsMailbox,
  findMailbox,
  mailboxByRole,
} from "./mailboxes"
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
  otherKeywords,
  MailAuthError,
  MailRequestError,
  MailTransportError,
  type AttachmentContent,
  type BulkResult,
  type DraftResult,
  type MailAddress,
  type MailBackend,
  type MailboxRole,
  type MailboxChange,
  type MailboxSummary,
  type MailCredential,
  type MailIdentity,
  type MailMessageDetail,
  type MailMessageSummary,
  type MarkChange,
  type MoveResult,
  type SearchQuery,
  type SearchResult,
  type SendInput,
  type SendResult,
  type VacationResponse,
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
const VACATION = "urn:ietf:params:jmap:vacationresponse"

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
  /** Whether it has an automatic reply (VacationResponse) to read and set. */
  vacation: boolean
}

export type JmapConfig = Omit<JmapSession, "vacation"> & {
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
    vacation:
      VACATION in capabilities &&
      (accountCapabilities === null || VACATION in accountCapabilities),
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

/**
 * One JMAP request: its method calls, answered by call id. A server can add
 * answers of its own under a call's id: for an EmailSubmission/set with
 * onSuccessUpdateEmail, RFC 8621 (7.5) has it run an Email/set and answer it
 * after the submission's own answer, with the same id. A call's answer is the
 * first one under its id named after its method (or an error); any other is
 * kept apart, under implicitKey, so it never stands in for the call's answer,
 * and a failure there does not read as the call failing.
 */
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
    const call = calls.find((candidate) => candidate[2] === id)

    if (
      typeof id === "string" &&
      (byId.has(id) || (name !== "error" && name !== call?.[0]))
    ) {
      if (isObject(args)) {
        byId.set(implicitKey(id, name), args)
      }

      continue
    }

    if (name === "error") {
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

/** Where jmapRequest keeps an answer the server added under a call's id. */
export function implicitKey(id: string, method: string): string {
  return `${id} ${method}`
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
    keywords: otherKeywords(
      Object.entries(keywords).flatMap(([name, on]) =>
        on === true ? [name] : [],
      ),
    ),
    hasAttachments: email.hasAttachment === true,
    size: typeof email.size === "number" ? email.size : null,
  }
}

function mailboxSummary(box: Json): MailboxSummary {
  return {
    id: String(box.id),
    name: typeof box.name === "string" ? box.name : String(box.id),
    path: null,
    role: role(box.role),
    parentId: typeof box.parentId === "string" ? box.parentId : null,
    totalEmails: typeof box.totalEmails === "number" ? box.totalEmails : null,
    unreadEmails:
      typeof box.unreadEmails === "number" ? box.unreadEmails : null,
  }
}

/**
 * Mailboxes with their paths: the names from the top, joined with "/", so
 * an assistant can tell two folders of one name apart and name one by path.
 */
function withPaths(boxes: MailboxSummary[]): MailboxSummary[] {
  const byId = new Map(boxes.map((box) => [box.id, box]))

  return boxes.map((box) => {
    const names = [box.name]
    let parent = box.parentId ? byId.get(box.parentId) : undefined

    // Bounded, in case a server answers with a loop.
    for (let depth = 0; parent && depth < boxes.length; depth++) {
      names.unshift(parent.name)
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }

    return { ...box, path: names.join("/") }
  })
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

    return withPaths(
      list(answerOf(answers, "m").list)
        .slice(0, MAX_MAILBOXES)
        .map(mailboxSummary),
    )
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

  /**
   * One Email/set changing every email named, with the same patch: the ids
   * it changed, and the ones it did not with why.
   */
  async function setEmails(
    ids: string[],
    patch: Json,
  ): Promise<{ updated: string[]; failed: BulkResult<never>["failed"] }> {
    const unique = [...new Set(ids)]
    const answers = await request([
      [
        "Email/set",
        {
          accountId,
          update: Object.fromEntries(unique.map((id) => [id, patch])),
        },
        "s",
      ],
    ])
    const notUpdated = answerOf(answers, "s").notUpdated
    const failed: BulkResult<never>["failed"] = []
    const updated: string[] = []

    for (const id of unique) {
      if (isObject(notUpdated) && notUpdated[id]) {
        const error = isObject(notUpdated[id]) ? notUpdated[id] : {}
        failed.push({
          id,
          error:
            error.type === "notFound"
              ? "No email with that id."
              : `The mail server did not change the email: ${String(error.type ?? "")}${error.description ? ` (${String(error.description).slice(0, 200)})` : ""}`,
        })
      } else {
        updated.push(id)
      }
    }

    return { updated, failed }
  }

  async function setEmail(id: string, patch: Json): Promise<void> {
    const { failed } = await setEmails([id], patch)

    if (failed[0]) {
      throw new MailRequestError(failed[0].error)
    }
  }

  async function move(
    ids: string[],
    target: MailboxSummary,
  ): Promise<BulkResult<MoveResult>> {
    const { updated, failed } = await setEmails(ids, {
      mailboxIds: { [target.id]: true },
    })

    return {
      done: updated.map((id) => ({ id, previousId: id, mailboxId: target.id })),
      failed,
    }
  }

  /** Mailbox/set, and the one answer it gives for the key or id named. */
  async function setMailbox(
    args: Json,
    key: string,
    what: "created" | "updated" | "destroyed",
  ): Promise<Json | null> {
    const answers = await request([
      ["Mailbox/set", { accountId, ...args }, "b"],
    ])
    const answer = answerOf(answers, "b")
    const not = {
      created: "notCreated",
      updated: "notUpdated",
      destroyed: "notDestroyed",
    }[what]
    const refused = isObject(answer[not]) ? answer[not][key] : null

    if (refused) {
      const type = isObject(refused) ? refused.type : null
      throw new MailRequestError(
        type === "mailboxHasEmail"
          ? "The mailbox still holds mail; move or delete it first. PCP never deletes mail for good."
          : type === "mailboxHasChild"
            ? "The mailbox has mailboxes inside it; delete or move them first."
            : `The mail server did not change the mailbox: ${describeSetError(refused)}`,
      )
    }

    if (what === "destroyed") {
      return null
    }

    const done = isObject(answer[what]) ? answer[what][key] : undefined
    return isObject(done) ? done : {}
  }

  /** A mailbox as list_mailboxes shows it, read again after a change. */
  async function mailboxById(id: string): Promise<MailboxSummary> {
    const box = (await mailboxes()).find((candidate) => candidate.id === id)

    if (!box) {
      throw new MailRequestError(
        "The mail server does not list the mailbox it changed.",
      )
    }

    return box
  }

  /**
   * The email send_email and create_draft write, without its mailbox and
   * keywords: from the identity (or, for a draft on an account that cannot
   * send, the account's From address), with the reply's headers, and with
   * the attachments uploaded. place() picks its mailbox, before anything is
   * uploaded, and refuses when there is none; nothing is created here.
   */
  async function compose(
    input: SendInput,
    {
      send,
      place,
    }: { send: boolean; place: (boxes: MailboxSummary[]) => MailboxSummary },
  ): Promise<{
    email: Json
    boxes: MailboxSummary[]
    home: MailboxSummary
    from: MailAddress | null
    messageId: string
    identityId: string
  }> {
    // Identities are part of submission: an account that cannot send has
    // none to ask for.
    const withIdentities = send || config.submission
    const first = await request(
      [
        ["Mailbox/get", { accountId, properties: ["id", "name", "role"] }, "m"],
        ...(withIdentities
          ? ([["Identity/get", { accountId }, "i"]] as MethodCall[])
          : []),
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
      withIdentities ? [CORE, MAIL, SUBMISSION] : [CORE, MAIL],
    )
    const boxes = withPaths(
      list(answerOf(first, "m").list)
        .slice(0, MAX_MAILBOXES)
        .map(mailboxSummary),
    )
    const identities = withIdentities ? list(answerOf(first, "i").list) : []
    const wantedFrom = config.from?.toLowerCase()
    const identity = input.identity
      ? identities.find((candidate) => candidate.id === input.identity)
      : (identities.find(
          (candidate) =>
            typeof candidate.email === "string" &&
            candidate.email.toLowerCase() === wantedFrom,
        ) ?? identities[0])

    if (input.identity && !identity) {
      throw new MailRequestError(
        withIdentities
          ? "No identity with that id; list_identities lists them."
          : "This account cannot send, so it has no identities: leave identity out.",
      )
    }

    if (send && (!identity || typeof identity.email !== "string")) {
      throw new MailRequestError("This account has no identity to send as.")
    }

    const home = place(boxes)
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

    const from: MailAddress | null =
      identity && typeof identity.email === "string"
        ? {
            name:
              typeof identity.name === "string" && identity.name
                ? identity.name
                : null,
            email: identity.email,
          }
        : config.from
          ? { name: null, email: config.from }
          : null
    const domain = from?.email.split("@")[1] ?? "pcp.invalid"
    const messageId = `${randomUUID()}@${domain}`
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

    return {
      email: {
        ...(from ? { from: [from] } : {}),
        ...(input.to.length ? { to: input.to } : {}),
        ...(input.cc.length ? { cc: input.cc } : {}),
        ...(input.bcc.length ? { bcc: input.bcc } : {}),
        subject: input.subject,
        messageId: [messageId],
        ...(inReplyTo.length ? { inReplyTo, references } : {}),
        bodyValues: { body: { value: input.text } },
        textBody: [{ partId: "body", type: "text/plain" }],
        ...(attached.length ? { attachments: attached } : {}),
      },
      boxes,
      home,
      from,
      messageId,
      identityId: identity ? String(identity.id) : "",
    }
  }

  return {
    listMailboxes: mailboxes,

    async searchEmails(query: SearchQuery): Promise<SearchResult> {
      const boxes = await mailboxes()
      const conditions: Json[] = []

      if (query.allMailboxes) {
        const left = (["trash", "junk"] as const).flatMap((name) => {
          const box = mailboxByRole(boxes, name)
          return box ? [box.id] : []
        })

        if (left.length) {
          conditions.push({ inMailboxOtherThan: left })
        }
      } else {
        const box = query.mailbox
          ? findMailbox(boxes, query.mailbox)
          : (mailboxByRole(boxes, "inbox") ?? findMailbox(boxes, "inbox"))
        conditions.push({ inMailbox: box.id })
      }

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
      if (query.keyword) {
        conditions.push({ hasKeyword: query.keyword.toLowerCase() })
      }
      if (query.notKeyword) {
        conditions.push({ notKeyword: query.notKeyword.toLowerCase() })
      }

      const answers = await request([
        [
          "Email/query",
          {
            accountId,
            ...(conditions.length === 0
              ? {}
              : {
                  filter:
                    conditions.length === 1
                      ? conditions[0]
                      : { operator: "AND", conditions },
                }),
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

      const { email, boxes, home, from, messageId, identityId } = await compose(
        input,
        {
          send: true,
          place: (boxes) => {
            const home = draftsMailbox(boxes) ?? mailboxByRole(boxes, "sent")

            if (!home) {
              throw new MailRequestError(
                "This account has no Drafts or Sent mailbox to send from.",
              )
            }

            return home
          },
        },
      )
      const draftsBox = draftsMailbox(boxes)
      const sentBox = mailboxByRole(boxes, "sent")
      const onSuccess: Json = { "keywords/$draft": null }

      if (draftsBox && sentBox) {
        onSuccess[`mailboxIds/${draftsBox.id}`] = null
        onSuccess[`mailboxIds/${sentBox.id}`] = true
      }

      const answers = await request(
        [
          [
            "Email/set",
            {
              accountId,
              create: {
                draft: {
                  ...email,
                  mailboxIds: { [home.id]: true },
                  keywords: { $draft: true, $seen: true },
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
                send: { identityId, emailId: "#draft" },
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
          `The mail server did not send the email (it is left in ${home.name}): ${describeSetError(error)}`,
        )
      }

      // The email has gone. Whether it left Drafts for Sent is the server's
      // own Email/set, answered under the submission's id.
      const draftId = typeof draft.id === "string" ? draft.id : null
      const filed = answers.get(implicitKey("s", "Email/set"))
      const notFiled =
        answers.has(implicitKey("s", "error")) ||
        (isObject(filed?.notUpdated) &&
          draftId !== null &&
          draftId in filed.notUpdated)

      // A reply marks the email it answers, as mail apps do; the email has
      // gone whatever happens here, so a refusal is reported, not thrown.
      let answered: boolean | undefined

      if (input.inReplyTo) {
        try {
          await setEmail(input.inReplyTo, { "keywords/$answered": true })
          answered = true
        } catch {
          answered = false
        }
      }

      return {
        id: draftId,
        messageId,
        from: from!,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        // Left in Drafts when the server would not move it.
        savedTo: sentBox && !(draftsBox && notFiled) ? sentBox.name : home.name,
        ...(answered !== undefined ? { answered } : {}),
      }
    },

    async createDraft(input: SendInput): Promise<DraftResult> {
      const { email, home, from, messageId } = await compose(input, {
        send: false,
        place: (boxes) => {
          const drafts = draftsMailbox(boxes)

          if (!drafts) {
            throw new MailRequestError(
              "This account has no Drafts mailbox to write the draft in.",
            )
          }

          return drafts
        },
      })
      // Email/set alone: no EmailSubmission, so nothing is sent.
      const answers = await request([
        [
          "Email/set",
          {
            accountId,
            create: {
              draft: {
                ...email,
                mailboxIds: { [home.id]: true },
                keywords: { $draft: true, $seen: true },
              },
            },
          },
          "e",
        ],
      ])
      const created = answerOf(answers, "e")
      const draft = isObject(created.created) ? created.created.draft : null

      if (!isObject(draft) || typeof draft.id !== "string") {
        const error = isObject(created.notCreated)
          ? created.notCreated.draft
          : null
        throw new MailRequestError(
          `The mail server did not take the draft: ${describeSetError(error)}`,
        )
      }

      return {
        id: draft.id,
        messageId,
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        mailboxId: home.id,
        mailbox: home.name,
      }
    },

    async moveEmails(ids, mailbox): Promise<BulkResult<MoveResult>> {
      return move(ids, findMailbox(await mailboxes(), mailbox))
    },

    async markEmails(
      ids,
      change: MarkChange,
    ): Promise<BulkResult<MailMessageSummary>> {
      const patch: Json = {}
      const set = (keyword: string, on: boolean | undefined) => {
        // A patch path is a JSON Pointer (RFC 8620 5.3): ~ and / escaped.
        if (on !== undefined) {
          patch[
            `keywords/${keyword.replace(/~/g, "~0").replace(/\//g, "~1")}`
          ] = on || null
        }
      }

      set("$seen", change.read)
      set("$flagged", change.flagged)
      set("$answered", change.answered)
      change.removeKeywords?.forEach((keyword) =>
        set(keyword.toLowerCase(), false),
      )
      change.addKeywords?.forEach((keyword) => set(keyword.toLowerCase(), true))

      const { updated, failed } = await setEmails(ids, patch)
      const done = await summaries(updated)
      const read = new Set(done.map((email) => email.id))

      return {
        done,
        failed: [
          ...failed,
          ...updated
            .filter((id) => !read.has(id))
            .map((id) => ({ id, error: "No email with that id." })),
        ],
      }
    },

    async deleteEmails(ids): Promise<BulkResult<MoveResult>> {
      const trash = mailboxByRole(await mailboxes(), "trash")

      if (!trash) {
        throw new MailRequestError(
          "This account has no Trash mailbox, and PCP never deletes an email for good.",
        )
      }

      return move(ids, trash)
    },

    async createMailbox(name, parent): Promise<MailboxSummary> {
      const boxes = await mailboxes()
      const under = parent ? findMailbox(boxes, parent) : null
      const created = await setMailbox(
        {
          create: {
            box: { name, parentId: under?.id ?? null, isSubscribed: true },
          },
        },
        "box",
        "created",
      )

      if (typeof created?.id !== "string") {
        throw new MailRequestError(
          "The mail server did not say what it named the new mailbox.",
        )
      }

      return mailboxById(created.id)
    },

    async renameMailbox(
      mailbox,
      change: MailboxChange,
    ): Promise<MailboxSummary> {
      const boxes = await mailboxes()
      const box = findMailbox(boxes, mailbox)
      const patch: Json = {}

      if (box.role === "inbox" && change.parent !== undefined) {
        throw new MailRequestError("The inbox stays at the top.")
      }

      if (change.name !== undefined) {
        patch.name = change.name
      }

      if (change.parent !== undefined) {
        const under = change.parent ? findMailbox(boxes, change.parent) : null
        checkNewParent(boxes, box, under)
        patch.parentId = under?.id ?? null
      }

      await setMailbox({ update: { [box.id]: patch } }, box.id, "updated")
      return mailboxById(box.id)
    },

    async deleteMailbox(mailbox): Promise<MailboxSummary> {
      const boxes = await mailboxes()
      const box = findMailbox(boxes, mailbox)
      checkDeletable(boxes, box)
      // The server refuses too when it holds mail: onDestroyRemoveEmails
      // false is what keeps an email from being deleted with its mailbox.
      await setMailbox(
        { destroy: [box.id], onDestroyRemoveEmails: false },
        box.id,
        "destroyed",
      )

      return box
    },

    async getVacationResponse(): Promise<VacationResponse> {
      return vacation()
    },

    async setVacationResponse(change): Promise<VacationResponse> {
      const patch: Json = { isEnabled: change.enabled }

      if (change.from !== undefined) {
        patch.fromDate = change.from === null ? null : utcDate(change.from)
      }
      if (change.to !== undefined) {
        patch.toDate = change.to === null ? null : utcDate(change.to)
      }
      if (change.subject !== undefined) patch.subject = change.subject
      if (change.text !== undefined) patch.textBody = change.text

      const answers = await request(
        [
          [
            "VacationResponse/set",
            { accountId, update: { singleton: patch } },
            "v",
          ],
        ],
        [CORE, VACATION],
      )
      const answer = answerOf(answers, "v")
      const refused = isObject(answer.notUpdated)
        ? answer.notUpdated.singleton
        : null

      if (refused) {
        throw new MailRequestError(
          `The mail server did not change the automatic reply: ${describeSetError(refused)}`,
        )
      }

      return vacation()
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

  async function vacation(): Promise<VacationResponse> {
    const answers = await request(
      [["VacationResponse/get", { accountId, ids: ["singleton"] }, "v"]],
      [CORE, VACATION],
    )
    const [found] = list(answerOf(answers, "v").list)
    const text = (value: unknown) => (typeof value === "string" ? value : null)

    if (!found) {
      throw new MailRequestError(
        "This mail server has no automatic reply for the account.",
      )
    }

    return {
      enabled: found.isEnabled === true,
      from: text(found.fromDate),
      to: text(found.toDate),
      subject: text(found.subject),
      text: text(found.textBody),
    }
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
