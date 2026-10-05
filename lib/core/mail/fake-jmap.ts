/**
 * An in-memory JMAP mail server for tests: the unit tests mount it on
 * startTestApi, the e2e suite on its fake upstream. It answers the methods
 * PCP uses (Mailbox/get, Email/query, Email/get, Email/set, Thread/get,
 * Identity/get, EmailSubmission/set) well enough to check what PCP sends
 * and what it makes of the answers, and records every request with its
 * Authorization header.
 */

type Json = Record<string, unknown>

export type FakeAttachment = {
  blobId: string
  name: string
  type: string
  content: string | Buffer
}

export type FakeEmail = {
  id: string
  threadId: string
  mailboxIds: Record<string, boolean>
  keywords: Record<string, boolean>
  receivedAt: string
  from: Array<{ name: string | null; email: string }>
  to: Array<{ name: string | null; email: string }>
  cc?: Array<{ name: string | null; email: string }>
  bcc?: Array<{ name: string | null; email: string }>
  subject: string
  messageId: string[]
  inReplyTo?: string[] | null
  references?: string[] | null
  text?: string
  html?: string
  attachments?: FakeAttachment[]
}

export type FakeRequest = {
  method: string
  path: string
  authorization: string | undefined
  body: unknown
}

export type FakeJmapOptions = {
  /** Where the server lives, e.g. "/jmap": session at <base>/session. */
  base?: string
  accountId?: string
  submission?: boolean
  /** Whether a request with this Authorization header may in. */
  authorize: (authorization: string | undefined) => boolean
  /** Overrides the apiUrl the session names (to test the origin rule). */
  apiUrl?: string
}

export type FakeJmap = {
  base: string
  emails: FakeEmail[]
  sent: Array<{ emailId: string; identityId: string }>
  requests: FakeRequest[]
  /** Answers a request, or null when its path is not the server's. */
  handle: (request: {
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
    body: string
  }) => { status: number; type: string; body: string | Buffer } | null
}

export const FAKE_MAILBOXES = [
  { id: "mb-inbox", name: "Inbox", role: "inbox", parentId: null },
  { id: "mb-drafts", name: "Drafts", role: "drafts", parentId: null },
  { id: "mb-sent", name: "Sent", role: "sent", parentId: null },
  { id: "mb-trash", name: "Trash", role: "trash", parentId: null },
  { id: "mb-archive", name: "Archive", role: "archive", parentId: null },
]

export const FAKE_IDENTITIES = [
  { id: "ident-1", name: "Ada Lovelace", email: "ada@example.com" },
]

export function fakeEmails(): FakeEmail[] {
  return [
    {
      id: "e1",
      threadId: "t1",
      mailboxIds: { "mb-inbox": true },
      keywords: {},
      receivedAt: "2026-10-01T09:00:00Z",
      from: [{ name: "Charles Babbage", email: "charles@example.com" }],
      to: [{ name: "Ada Lovelace", email: "ada@example.com" }],
      subject: "The engine",
      messageId: ["engine-1@example.com"],
      text: "Shall we meet about the engine on Thursday?",
      attachments: [
        {
          blobId: "blob-csv",
          name: "parts.csv",
          type: "text/csv",
          content: "part,count\ncog,42\n",
        },
        {
          blobId: "blob-png",
          name: "drawing.png",
          type: "image/png",
          content: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
          ]),
        },
      ],
    },
    {
      id: "e2",
      threadId: "t2",
      mailboxIds: { "mb-inbox": true },
      keywords: { $seen: true, $flagged: true },
      receivedAt: "2026-10-02T09:00:00Z",
      from: [{ name: null, email: "news@example.com" }],
      to: [{ name: null, email: "ada@example.com" }],
      subject: "Newsletter",
      messageId: ["news-2@example.com"],
      html: '<p>Read <a href="https://example.com/n">the news</a>.</p>',
    },
    {
      id: "e3",
      threadId: "t1",
      mailboxIds: { "mb-inbox": true },
      keywords: { $seen: true },
      receivedAt: "2026-10-03T09:00:00Z",
      from: [{ name: "Charles Babbage", email: "charles@example.com" }],
      to: [{ name: "Ada Lovelace", email: "ada@example.com" }],
      subject: "Re: The engine",
      messageId: ["engine-3@example.com"],
      inReplyTo: ["engine-1@example.com"],
      references: ["engine-1@example.com"],
      text: `A long letter.\n${"The engine weaves algebraic patterns. ".repeat(3000)}\nYours, Charles`,
    },
  ]
}

function textOf(email: FakeEmail): string {
  return email.text ?? email.html ?? ""
}

function matches(email: FakeEmail, filter: Json | undefined): boolean {
  if (!filter) {
    return true
  }

  if (filter.operator === "AND" && Array.isArray(filter.conditions)) {
    return (filter.conditions as Json[]).every((c) => matches(email, c))
  }

  const lower = (value: unknown) => String(value).toLowerCase()
  const addresses = (list?: FakeEmail["from"]) =>
    (list ?? [])
      .map((a) => `${a.name ?? ""} ${a.email}`.toLowerCase())
      .join(" ")

  if (filter.inMailbox && !email.mailboxIds[String(filter.inMailbox)])
    return false
  if (
    filter.text &&
    !`${email.subject} ${textOf(email)} ${addresses(email.from)}`
      .toLowerCase()
      .includes(lower(filter.text))
  )
    return false
  if (filter.from && !addresses(email.from).includes(lower(filter.from)))
    return false
  if (filter.to && !addresses(email.to).includes(lower(filter.to))) return false
  if (
    filter.subject &&
    !email.subject.toLowerCase().includes(lower(filter.subject))
  )
    return false
  if (filter.hasKeyword && !email.keywords[String(filter.hasKeyword)])
    return false
  if (filter.notKeyword && email.keywords[String(filter.notKeyword)])
    return false
  if (
    typeof filter.hasAttachment === "boolean" &&
    Boolean(email.attachments?.length) !== filter.hasAttachment
  )
    return false
  if (
    filter.after &&
    Date.parse(email.receivedAt) < Date.parse(String(filter.after))
  )
    return false
  if (
    filter.before &&
    Date.parse(email.receivedAt) >= Date.parse(String(filter.before))
  )
    return false

  return true
}

function view(email: FakeEmail, args: Json): Json {
  const maxBytes =
    typeof args.maxBodyValueBytes === "number" ? args.maxBodyValueBytes : 0
  const bodyValues: Json = {}
  const textBody: Json[] = []

  if (email.text !== undefined || email.html !== undefined) {
    const html = email.text === undefined
    const value = textOf(email)
    textBody.push({
      partId: "1",
      blobId: `${email.id}-body`,
      type: html ? "text/html" : "text/plain",
      size: value.length,
    })

    if (args.fetchTextBodyValues) {
      const cut = maxBytes > 0 && Buffer.byteLength(value) > maxBytes
      bodyValues["1"] = {
        value: cut
          ? Buffer.from(value).subarray(0, maxBytes).toString("utf8")
          : value,
        isTruncated: cut,
      }
    }
  }

  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds: email.mailboxIds,
    keywords: email.keywords,
    receivedAt: email.receivedAt,
    from: email.from,
    to: email.to,
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    replyTo: null,
    subject: email.subject,
    preview: textOf(email).slice(0, 100),
    hasAttachment: Boolean(email.attachments?.length),
    size: textOf(email).length,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo ?? null,
    references: email.references ?? null,
    textBody,
    bodyValues,
    attachments: (email.attachments ?? []).map((a) => ({
      partId: a.blobId,
      blobId: a.blobId,
      name: a.name,
      type: a.type,
      size: Buffer.byteLength(a.content),
    })),
  }
}

/** A JSON Pointer back-reference (RFC 8620 3.7), the two shapes PCP uses. */
function resolve(ref: Json, answers: Map<string, Json>): unknown {
  const answer = answers.get(String(ref.resultOf))

  if (!answer) {
    return []
  }

  if (ref.path === "/ids") {
    return answer.ids
  }

  if (ref.path === "/list/*/emailIds") {
    return (answer.list as Json[]).flatMap((item) => item.emailIds as string[])
  }

  return []
}

function applyPatch(email: FakeEmail, patch: Json): void {
  for (const [path, value] of Object.entries(patch)) {
    if (path === "mailboxIds") {
      email.mailboxIds = value as Record<string, boolean>
    } else if (path.startsWith("mailboxIds/")) {
      const key = path.slice("mailboxIds/".length)
      if (value) email.mailboxIds[key] = true
      else delete email.mailboxIds[key]
    } else if (path.startsWith("keywords/")) {
      const key = path.slice("keywords/".length)
      if (value) email.keywords[key] = true
      else delete email.keywords[key]
    }
  }
}

export function createFakeJmap(options: FakeJmapOptions): FakeJmap {
  const base = options.base ?? "/jmap"
  const accountId = options.accountId ?? "acct-1"
  const submission = options.submission ?? true
  const emails = fakeEmails()
  const sent: FakeJmap["sent"] = []
  const requests: FakeRequest[] = []
  let created = 0

  function json(status: number, body: unknown) {
    return { status, type: "application/json", body: JSON.stringify(body) }
  }

  function call(
    name: string,
    args: Json,
    answers: Map<string, Json>,
    ids: Map<string, string>,
  ): [string, Json] {
    if (args.accountId !== accountId) {
      return ["error", { type: "accountNotFound" }]
    }

    switch (name) {
      case "Mailbox/get":
        return [
          name,
          {
            accountId,
            list: FAKE_MAILBOXES.map((box) => ({
              ...box,
              totalEmails: emails.filter((e) => e.mailboxIds[box.id]).length,
              unreadEmails: emails.filter(
                (e) => e.mailboxIds[box.id] && !e.keywords.$seen,
              ).length,
            })),
            notFound: [],
          },
        ]
      case "Identity/get":
        return [name, { accountId, list: FAKE_IDENTITIES, notFound: [] }]
      case "Email/query": {
        const found = emails
          .filter((email) => matches(email, args.filter as Json | undefined))
          .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
        const position = Number(args.position ?? 0)
        const limit = Number(args.limit ?? 50)
        return [
          name,
          {
            accountId,
            ids: found.slice(position, position + limit).map((e) => e.id),
            position,
            total: found.length,
          },
        ]
      }
      case "Email/get": {
        const wanted = (
          args["#ids"] ? resolve(args["#ids"] as Json, answers) : args.ids
        ) as string[]
        const list = wanted.flatMap((id) => {
          const email = emails.find((e) => e.id === id)
          return email ? [view(email, args)] : []
        })
        return [
          name,
          {
            accountId,
            list,
            notFound: wanted.filter((id) => !emails.some((e) => e.id === id)),
          },
        ]
      }
      case "Thread/get": {
        const list = (args.ids as string[]).flatMap((id) => {
          const inThread = emails
            .filter((e) => e.threadId === id)
            .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
          return inThread.length
            ? [{ id, emailIds: inThread.map((e) => e.id) }]
            : []
        })
        return [name, { accountId, list, notFound: [] }]
      }
      case "Email/set": {
        const result: Json = {
          accountId,
          created: {},
          updated: {},
          notCreated: {},
          notUpdated: {},
        }

        for (const [key, value] of Object.entries(
          (args.create as Json) ?? {},
        )) {
          const draft = value as Json
          const id = `e-new-${++created}`
          const body = ((draft.bodyValues as Json)?.body as Json)?.value
          emails.push({
            id,
            threadId: `t-new-${created}`,
            mailboxIds: draft.mailboxIds as Record<string, boolean>,
            keywords: draft.keywords as Record<string, boolean>,
            receivedAt: new Date().toISOString(),
            from: draft.from as FakeEmail["from"],
            to: draft.to as FakeEmail["to"],
            cc: draft.cc as FakeEmail["cc"],
            bcc: draft.bcc as FakeEmail["bcc"],
            subject: String(draft.subject ?? ""),
            messageId: (draft.messageId as string[]) ?? [],
            inReplyTo: (draft.inReplyTo as string[]) ?? null,
            references: (draft.references as string[]) ?? null,
            text: typeof body === "string" ? body : "",
          })
          ids.set(key, id)
          ;(result.created as Json)[key] = { id, threadId: `t-new-${created}` }
        }

        for (const [id, patch] of Object.entries((args.update as Json) ?? {})) {
          const email = emails.find((e) => e.id === id)
          if (!email) {
            ;(result.notUpdated as Json)[id] = { type: "notFound" }
            continue
          }
          applyPatch(email, patch as Json)
          ;(result.updated as Json)[id] = null
        }

        return [name, result]
      }
      case "EmailSubmission/set": {
        if (!submission) {
          return ["error", { type: "unknownMethod" }]
        }

        const result: Json = { accountId, created: {}, notCreated: {} }

        for (const [key, value] of Object.entries(
          (args.create as Json) ?? {},
        )) {
          const submissionArgs = value as Json
          const emailRef = String(submissionArgs.emailId)
          const emailId = emailRef.startsWith("#")
            ? ids.get(emailRef.slice(1))
            : emailRef
          const email = emails.find((e) => e.id === emailId)

          if (!email) {
            ;(result.notCreated as Json)[key] = {
              type: "invalidProperties",
              description: "no such email",
            }
            continue
          }

          sent.push({
            emailId: email.id,
            identityId: String(submissionArgs.identityId),
          })
          ;(result.created as Json)[key] = { id: `sub-${sent.length}` }
          const update = (args.onSuccessUpdateEmail as Json | undefined)?.[
            `#${key}`
          ]
          if (update) applyPatch(email, update as Json)
        }

        return [name, result]
      }
      default:
        return ["error", { type: "unknownMethod" }]
    }
  }

  return {
    base,
    emails,
    sent,
    requests,
    handle(request) {
      const url = new URL(request.url, "http://fake")

      if (!url.pathname.startsWith(`${base}/`)) {
        return null
      }

      const header = request.headers.authorization
      const authorization = Array.isArray(header) ? header[0] : header
      let body: unknown = null

      try {
        body = request.body ? JSON.parse(request.body) : null
      } catch {
        body = request.body
      }

      requests.push({
        method: request.method,
        path: url.pathname,
        authorization,
        body,
      })

      if (!options.authorize(authorization)) {
        return json(401, {
          type: "about:blank",
          status: 401,
          detail: "Unauthorized",
        })
      }

      const origin = String(
        request.headers.host
          ? `http://${String(request.headers.host)}`
          : "http://fake",
      )

      if (url.pathname === `${base}/session` && request.method === "GET") {
        return json(200, {
          capabilities: {
            "urn:ietf:params:jmap:core": { maxSizeUpload: 1_000_000 },
            "urn:ietf:params:jmap:mail": {},
            ...(submission ? { "urn:ietf:params:jmap:submission": {} } : {}),
          },
          accounts: {
            [accountId]: {
              name: "ada@example.com",
              isPersonal: true,
              accountCapabilities: {
                "urn:ietf:params:jmap:mail": {},
                ...(submission
                  ? { "urn:ietf:params:jmap:submission": {} }
                  : {}),
              },
            },
          },
          primaryAccounts: { "urn:ietf:params:jmap:mail": accountId },
          username: "ada@example.com",
          apiUrl: options.apiUrl ?? `${base}/api`,
          downloadUrl: `${origin}${base}/download/{accountId}/{blobId}/{name}?type={type}`,
          uploadUrl: `${base}/upload/{accountId}`,
          eventSourceUrl: `${base}/events`,
          state: "s1",
        })
      }

      if (url.pathname === `${base}/api` && request.method === "POST") {
        const payload = body as Json | null

        if (!payload || !Array.isArray(payload.methodCalls)) {
          return json(400, { type: "urn:ietf:params:jmap:error:notRequest" })
        }

        const answers = new Map<string, Json>()
        const ids = new Map<string, string>()
        const methodResponses = (
          payload.methodCalls as Array<[string, Json, string]>
        ).map(([name, args, id]) => {
          const [answerName, answer] = call(name, args, answers, ids)
          answers.set(id, answer)
          return [answerName, answer, id]
        })

        return json(200, { methodResponses, sessionState: "s1" })
      }

      const download = new RegExp(`^${base}/download/([^/]+)/([^/]+)/`).exec(
        url.pathname,
      )

      if (download && request.method === "GET") {
        const blobId = decodeURIComponent(download[2]!)
        const attachment = emails
          .flatMap((e) => e.attachments ?? [])
          .find((a) => a.blobId === blobId)

        return attachment
          ? { status: 200, type: attachment.type, body: attachment.content }
          : json(404, { type: "about:blank", status: 404 })
      }

      return json(404, { type: "about:blank", status: 404 })
    },
  }
}
