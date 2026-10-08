import { afterEach, describe, expect, it } from "vitest"

import { startTestApi, type TestApi } from "../openapi/test-api"
import { createFakeJmap, type FakeJmap } from "./fake-jmap"
import {
  fetchJmapSession,
  implicitKey,
  jmapRequest,
  openJmapBackend,
} from "./jmap"
import {
  MailAuthError,
  MailRequestError,
  MailTransportError,
  type MailCredential,
} from "./types"

// PCP's JMAP client against an in-memory JMAP server on 127.0.0.1.

const BASIC = `Basic ${Buffer.from("ada@example.com:app-password").toString("base64")}`

let api: TestApi | null = null

afterEach(async () => {
  await api?.close()
  api = null
})

async function serve(
  options: Partial<Parameters<typeof createFakeJmap>[0]> = {},
): Promise<{ fake: FakeJmap; origin: string; sessionUrl: string }> {
  const fake = createFakeJmap({
    authorize: (header) => header === BASIC,
    ...options,
  })
  api = await startTestApi((request, res) => {
    const answer = fake.handle(request)

    if (!answer) {
      res.statusCode = 404
      res.end()
      return
    }

    res.statusCode = answer.status
    res.setHeader("content-type", answer.type)
    res.end(answer.body)
  })

  return { fake, origin: api.origin, sessionUrl: `${api.origin}/jmap/session` }
}

describe("a session over http://", () => {
  it("is never sent to a public address, the credential included", async () => {
    // An IP literal is refused before anything connects.
    await expect(
      fetchJmapSession("http://8.8.8.8/.well-known/jmap", basic()),
    ).rejects.toThrow(/unencrypted.*Use an https:\/\/ session URL/)
  })
})

function basic(): MailCredential {
  return {
    headers: { Authorization: BASIC },
    login: { username: "ada@example.com", password: "app-password" },
    redact: ["app-password", BASIC],
  }
}

async function backend(options?: Parameters<typeof serve>[0]) {
  const served = await serve(options)
  const session = await fetchJmapSession(served.sessionUrl, basic())
  return {
    ...served,
    session,
    mail: openJmapBackend({ ...session, from: null }, basic()),
  }
}

describe("the session", () => {
  it("names the API on the same origin, the mail account and whether it may send", async () => {
    const { fake, origin, sessionUrl } = await serve()
    const session = await fetchJmapSession(sessionUrl, basic())

    expect(session).toEqual({
      apiUrl: `${origin}/jmap/api`,
      downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
      uploadUrl: `${origin}/jmap/upload/{accountId}`,
      accountId: "acct-1",
      submission: true,
      vacation: true,
    })
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      path: "/jmap/session",
      authorization: BASIC,
    })
  })

  it("takes an upload address only on the session's origin", async () => {
    const { sessionUrl } = await serve({
      uploadUrl: "https://elsewhere.example.com/upload/{accountId}",
    })
    expect((await fetchJmapSession(sessionUrl, basic())).uploadUrl).toBeNull()

    const none = await serve({ uploadUrl: null })
    expect(
      (await fetchJmapSession(none.sessionUrl, basic())).uploadUrl,
    ).toBeNull()
  })

  it("refuses a template whose scheme has no slashes", async () => {
    // "https:host/x" is a path on the session URL when resolved against it,
    // and another host once it is fetched on its own.
    const first = await serve({
      uploadUrl: "https:evil.example.com/upload/{accountId}",
    })
    expect(
      (await fetchJmapSession(first.sessionUrl, basic())).uploadUrl,
    ).toBeNull()

    const second = await serve({
      uploadUrl: `${new URL(api!.origin).protocol}evil.example.com:8443/{accountId}`,
    })
    expect(
      (await fetchJmapSession(second.sessionUrl, basic())).uploadUrl,
    ).toBeNull()
  })

  it("says when the account may not send", async () => {
    const { sessionUrl } = await serve({ submission: false })
    expect((await fetchJmapSession(sessionUrl, basic())).submission).toBe(false)
  })

  it("refuses an API on another origin", async () => {
    const { sessionUrl } = await serve({
      apiUrl: "https://elsewhere.example.com/jmap",
    })

    await expect(fetchJmapSession(sessionUrl, basic())).rejects.toThrow(
      /another address than the one you entered/,
    )
  })

  it("does not follow a redirect, and names where it went", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 301
      res.setHeader("location", "/jmap/session")
      res.end()
    })

    const failure = fetchJmapSession(`${api.origin}/.well-known/jmap`, basic())
    await expect(failure).rejects.toBeInstanceOf(MailTransportError)
    await expect(failure).rejects.toThrow(
      `redirect to ${api.origin}/jmap/session`,
    )
    expect(api.requests).toHaveLength(1)
  })

  it("explains a server that is not JMAP", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 404
      res.end("Not here")
    })

    await expect(
      fetchJmapSession(`${api.origin}/jmap/session`, basic()),
    ).rejects.toThrow(/HTTP 404: Not here. The session URL is usually/)
  })
})

describe("credentials", () => {
  it("refuses the wrong ones", async () => {
    const { sessionUrl } = await serve()

    await expect(
      fetchJmapSession(sessionUrl, {
        headers: { Authorization: "Basic d3Jvbmc=" },
        login: null,
        redact: [],
      }),
    ).rejects.toBeInstanceOf(MailAuthError)
  })

  it("renews an OAuth token once, and keeps the new one out of answers", async () => {
    const { fake, sessionUrl } = await serve({
      authorize: (header) => header === "Bearer fresh-token",
    })
    let renewals = 0
    const credential: MailCredential = {
      headers: { Authorization: "Bearer stale-token" },
      login: null,
      redact: ["stale-token"],
      onUnauthorized: async () => {
        renewals++
        return {
          headers: { Authorization: "Bearer fresh-token" },
          redact: ["fresh-token", "Bearer fresh-token"],
        }
      },
    }

    await fetchJmapSession(sessionUrl, credential)

    expect(renewals).toBe(1)
    expect(fake.requests.map((request) => request.authorization)).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ])
    expect(credential.redact).toContain("fresh-token")
  })

  it("gives up when the renewed token is refused too, or cannot be had", async () => {
    const { fake, sessionUrl } = await serve({ authorize: () => false })
    let renewals = 0

    await expect(
      fetchJmapSession(sessionUrl, {
        headers: { Authorization: "Bearer stale" },
        login: null,
        redact: [],
        onUnauthorized: async () => {
          renewals++
          return { headers: { Authorization: "Bearer also-bad" }, redact: [] }
        },
      }),
    ).rejects.toBeInstanceOf(MailAuthError)
    expect(renewals).toBe(1)
    expect(fake.requests).toHaveLength(2)

    await expect(
      fetchJmapSession(sessionUrl, {
        headers: { Authorization: "Bearer stale" },
        login: null,
        redact: [],
        onUnauthorized: async () => null,
      }),
    ).rejects.toBeInstanceOf(MailAuthError)
  })
})

describe("requests", () => {
  it("turns a method error into a refusal of that request", async () => {
    const { session } = await backend()

    await expect(
      jmapRequest(session.apiUrl, basic(), [
        ["Mailbox/get", { accountId: "someone-else" }, "m"],
      ]),
    ).rejects.toThrow(/Mailbox\/get failed with accountNotFound/)
  })

  it("tells a refused request from a failing server", async () => {
    api = await startTestApi((request, res) => {
      res.statusCode = request.url === "/bad" ? 400 : 503
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          type: "urn:ietf:params:jmap:error:limit",
          detail: "too many",
        }),
      )
    })

    await expect(
      jmapRequest(`${api.origin}/bad`, basic(), []),
    ).rejects.toBeInstanceOf(MailRequestError)
    await expect(
      jmapRequest(`${api.origin}/down`, basic(), []),
    ).rejects.toBeInstanceOf(MailTransportError)
  })

  it("keeps an answer the server adds under a call's id apart from the call's own", async () => {
    // RFC 8621 7.5: a submission's onSuccessUpdateEmail is answered by an
    // Email/set of the server's, under the submission's call id, after it.
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          methodResponses: [
            ["EmailSubmission/set", { created: { send: { id: "s1" } } }, "s"],
            ["Email/set", { updated: { e9: null } }, "s"],
            ["error", { type: "serverFail" }, "s"],
          ],
        }),
      )
    })

    const answers = await jmapRequest(`${api.origin}/api`, basic(), [
      ["EmailSubmission/set", {}, "s"],
    ])

    expect(answers.get("s")).toEqual({ created: { send: { id: "s1" } } })
    expect(answers.get(implicitKey("s", "Email/set"))).toEqual({
      updated: { e9: null },
    })
    // A failure of the server's own call is not the submission failing.
    expect(answers.get(implicitKey("s", "error"))).toEqual({
      type: "serverFail",
    })
  })

  it("says when the server cannot be reached", async () => {
    const { sessionUrl } = await serve()
    await api!.close()
    api = null

    await expect(fetchJmapSession(sessionUrl, basic())).rejects.toThrow(
      /could not be reached/,
    )
  })
})

describe("the mail tools' work", () => {
  it("lists mailboxes with their roles and counts", async () => {
    const { mail } = await backend()
    const boxes = await mail.listMailboxes()

    expect(boxes.find((box) => box.role === "inbox")).toMatchObject({
      id: "mb-inbox",
      name: "Inbox",
      totalEmails: 3,
      unreadEmails: 1,
    })
    expect(boxes.map((box) => box.role)).toEqual([
      "inbox",
      "drafts",
      "sent",
      "trash",
      "archive",
    ])
  })

  it("searches the inbox newest first, with filters and paging", async () => {
    const { mail, fake } = await backend()

    const all = await mail.searchEmails({ offset: 0, limit: 20 })
    expect(all.emails.map((email) => email.id)).toEqual(["e3", "e2", "e1"])
    expect(all.total).toBe(3)
    expect(all.emails[2]).toMatchObject({
      from: [{ name: "Charles Babbage", email: "charles@example.com" }],
      flags: { unread: true, flagged: false },
      hasAttachments: true,
    })

    const unread = await mail.searchEmails({
      unread: true,
      offset: 0,
      limit: 20,
    })
    expect(unread.emails.map((email) => email.id)).toEqual(["e1"])

    const second = await mail.searchEmails({ offset: 1, limit: 1 })
    expect(second.emails.map((email) => email.id)).toEqual(["e2"])

    await mail.searchEmails({
      mailbox: "archive",
      after: "2026-10-01",
      flagged: true,
      offset: 0,
      limit: 5,
    })
    const query = (fake.requests.at(-1)!.body as { methodCalls: unknown[][] })
      .methodCalls[0]![1] as { filter: unknown }
    expect(query.filter).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "mb-archive" },
        { after: "2026-10-01T00:00:00Z" },
        { hasKeyword: "$flagged" },
      ],
    })
  })

  it("refuses a mailbox that is not there", async () => {
    const { mail } = await backend()

    await expect(
      mail.searchEmails({ mailbox: "Projects", offset: 0, limit: 5 }),
    ).rejects.toThrow(/No mailbox called Projects/)
  })

  it("reads an email's text, made plain from HTML when that is all it has", async () => {
    const { mail } = await backend()

    const plain = await mail.getEmail("e1", { bodyBytes: 10_000 })
    expect(plain.body).toEqual({
      text: "Shall we meet about the engine on Thursday?",
      source: "text",
      truncated: false,
    })
    expect(plain.attachments).toEqual([
      { id: "blob-csv", name: "parts.csv", type: "text/csv", size: 18 },
      { id: "blob-png", name: "drawing.png", type: "image/png", size: 12 },
    ])
    expect(plain.messageId).toBe("engine-1@example.com")

    const html = await mail.getEmail("e2", { bodyBytes: 10_000 })
    expect(html.body).toEqual({
      text: "Read the news (https://example.com/n).",
      source: "html",
      truncated: false,
    })

    const long = await mail.getEmail("e3", { bodyBytes: 1000 })
    expect(long.body.truncated).toBe(true)
    expect(long.body.text.length).toBeLessThanOrEqual(1000)

    await expect(mail.getEmail("nope", { bodyBytes: 10 })).rejects.toThrow(
      /No email with that id/,
    )
  })

  it("reads a conversation oldest first", async () => {
    const { mail } = await backend()

    expect((await mail.getThread!("t1")).map((email) => email.id)).toEqual([
      "e1",
      "e3",
    ])
  })

  it("sends as the account's identity, into its conversation, and files it in Sent", async () => {
    const { mail, fake } = await backend()

    const sent = await mail.sendEmail!({
      to: [{ name: "Charles Babbage", email: "charles@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: The engine",
      text: "Thursday suits me.",
      inReplyTo: "e1",
    })

    expect(sent).toMatchObject({
      from: { name: "Ada Lovelace", email: "ada@example.com" },
      savedTo: "Sent",
    })
    expect(sent.messageId).toMatch(/@example\.com$/)
    expect(fake.sent).toEqual([{ emailId: sent.id, identityId: "ident-1" }])

    const stored = fake.emails.find((email) => email.id === sent.id)!
    expect(stored).toMatchObject({
      mailboxIds: { "mb-sent": true },
      inReplyTo: ["engine-1@example.com"],
      references: ["engine-1@example.com"],
      text: "Thursday suits me.",
    })
    expect(stored.keywords.$draft).toBeUndefined()
    // The email it answers is marked answered, as a mail app would.
    expect(sent.answered).toBe(true)
    expect(
      fake.emails.find((email) => email.id === "e1")!.keywords,
    ).toMatchObject({ $answered: true })
  })

  it("sends when the server will not move the email to Sent, and says it is left in Drafts", async () => {
    for (const onSuccessUpdate of ["refuse", "error"] as const) {
      const { mail, fake } = await backend({ onSuccessUpdate })

      const sent = await mail.sendEmail!({
        to: [{ name: null, email: "charles@example.com" }],
        cc: [],
        bcc: [],
        subject: "The engine",
        text: "Thursday suits me.",
      })

      expect(fake.sent).toEqual([{ emailId: sent.id, identityId: "ident-1" }])
      expect(sent.savedTo).toBe("Drafts")
      // Not a reply: nothing to mark.
      expect(sent).not.toHaveProperty("answered")
      await api!.close()
      api = null
    }
  })

  it("says so when the email it answers cannot be marked, and the email still goes", async () => {
    const fake = createFakeJmap({ authorize: (header) => header === BASIC })
    api = await startTestApi((request, res) => {
      // The server refuses only the change that marks the original.
      if (request.body.includes("keywords/$answered")) {
        res.setHeader("content-type", "application/json")
        res.end(
          JSON.stringify({
            methodResponses: [
              ["Email/set", { notUpdated: { e1: { type: "forbidden" } } }, "s"],
            ],
          }),
        )
        return
      }

      const answer = fake.handle(request)
      res.statusCode = answer?.status ?? 404
      res.setHeader("content-type", answer?.type ?? "text/plain")
      res.end(answer?.body ?? "")
    })
    const session = await fetchJmapSession(
      `${api.origin}/jmap/session`,
      basic(),
    )
    const mail = openJmapBackend({ ...session, from: null }, basic())

    const sent = await mail.sendEmail!({
      to: [{ name: null, email: "charles@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: The engine",
      text: "Thursday suits me.",
      inReplyTo: "e1",
    })

    expect(fake.sent).toHaveLength(1)
    expect(sent).toMatchObject({ savedTo: "Sent", answered: false })
  })

  it("uploads each attachment, then sends the email carrying them", async () => {
    const { mail, fake } = await backend()
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
    ])

    const sent = await mail.sendEmail!({
      to: [{ name: null, email: "charles@example.com" }],
      cc: [],
      bcc: [],
      subject: "The drawing",
      text: "Attached.",
      attachments: [
        { name: "drawing.png", type: "image/png", bytes: png },
        { name: "parts.csv", type: "text/csv", bytes: Buffer.from("a,b\n") },
      ],
    })

    const uploads = fake.requests.filter((request) =>
      request.path.startsWith("/jmap/upload/"),
    )
    expect(uploads).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/jmap/upload/acct-1",
        authorization: BASIC,
        body: "9 bytes",
      }),
      expect.objectContaining({ body: "4 bytes" }),
    ])
    expect(fake.uploads[0]).toMatchObject({ type: "image/png" })
    expect(fake.uploads[0]!.content.equals(png)).toBe(true)

    const stored = fake.emails.find((email) => email.id === sent.id)!
    expect(stored.attachments).toEqual([
      {
        blobId: "blob-up-1",
        name: "drawing.png",
        type: "image/png",
        content: png,
      },
      expect.objectContaining({ name: "parts.csv", type: "text/csv" }),
    ])
  })

  it("sends nothing when it cannot upload an attachment", async () => {
    const { mail, fake } = await backend({ uploadUrl: null })

    await expect(
      mail.sendEmail!({
        to: [{ name: null, email: "x@example.com" }],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
        attachments: [
          {
            name: "a.bin",
            type: "application/octet-stream",
            bytes: Buffer.from([1]),
          },
        ],
      }),
    ).rejects.toThrow(/offers no uploads/)
    expect(fake.sent).toEqual([])
    expect(
      fake.requests.some((request) =>
        JSON.stringify(request.body).includes("Email/set"),
      ),
    ).toBe(false)
  })

  it("will not send from an account that may not", async () => {
    const { mail } = await backend({ submission: false })

    await expect(
      mail.sendEmail!({
        to: [{ name: null, email: "x@example.com" }],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
      }),
    ).rejects.toThrow(/cannot send/)
  })

  it("writes a draft into Drafts, marked as a draft, and submits nothing", async () => {
    const { mail, fake } = await backend()
    const pdf = Buffer.from("%PDF-1.7 the plan")

    const draft = await mail.createDraft({
      to: [{ name: "Charles Babbage", email: "charles@example.com" }],
      cc: [],
      bcc: [{ name: null, email: "archive@example.com" }],
      subject: "Re: The engine",
      text: "Thursday suits me.",
      inReplyTo: "e1",
      attachments: [{ name: "plan.pdf", type: "application/pdf", bytes: pdf }],
    })

    expect(draft).toMatchObject({
      from: { name: "Ada Lovelace", email: "ada@example.com" },
      to: [{ name: "Charles Babbage", email: "charles@example.com" }],
      subject: "Re: The engine",
      mailboxId: "mb-drafts",
      mailbox: "Drafts",
    })
    expect(draft.messageId).toMatch(/@example\.com$/)
    // Nothing is sent: no submission was asked for at all.
    expect(fake.sent).toEqual([])
    expect(JSON.stringify(fake.requests)).not.toContain("EmailSubmission")

    const stored = fake.emails.find((email) => email.id === draft.id)!
    expect(stored).toMatchObject({
      mailboxIds: { "mb-drafts": true },
      keywords: { $draft: true, $seen: true },
      bcc: [{ name: null, email: "archive@example.com" }],
      inReplyTo: ["engine-1@example.com"],
      references: ["engine-1@example.com"],
      text: "Thursday suits me.",
      attachments: [
        { blobId: "blob-up-1", name: "plan.pdf", type: "application/pdf" },
      ],
    })
    expect(fake.uploads[0]!.content.equals(pdf)).toBe(true)
    // A draft answers nothing yet.
    expect(fake.emails.find((email) => email.id === "e1")!.keywords).toEqual({})

    // get_email reads it by the id the answer gave.
    const read = await mail.getEmail(draft.id!, { bodyBytes: 1000 })
    expect(read).toMatchObject({
      subject: "Re: The engine",
      flags: { draft: true, unread: false },
      body: { text: "Thursday suits me." },
    })
  })

  it("writes a draft to nobody yet, on an account that cannot send", async () => {
    const { mail, fake, session } = await backend({ submission: false })

    const draft = await mail.createDraft({
      to: [],
      cc: [],
      bcc: [],
      subject: "Notes",
      text: "To finish later.",
    })

    expect(draft).toMatchObject({ from: null, to: [], mailboxId: "mb-drafts" })
    expect(draft.messageId).toMatch(/@pcp\.invalid$/)
    expect(fake.emails.find((email) => email.id === draft.id)).toMatchObject({
      to: [],
      keywords: { $draft: true, $seen: true },
    })
    // Identities belong to submission, which this account does not have.
    expect(JSON.stringify(fake.requests)).not.toContain("Identity/get")

    // The owner's From address, when they gave one.
    const from = openJmapBackend(
      { ...session, from: "ada@example.org" },
      basic(),
    )
    expect(
      await from.createDraft({
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
      }),
    ).toMatchObject({ from: { name: null, email: "ada@example.org" } })
    await expect(
      from.createDraft({
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
        identity: "ident-1",
      }),
    ).rejects.toThrow(/leave identity out/)
  })

  it("writes no draft when it cannot upload an attachment", async () => {
    const { mail, fake } = await backend({ uploadUrl: null })

    await expect(
      mail.createDraft({
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
        attachments: [
          {
            name: "a.bin",
            type: "application/octet-stream",
            bytes: Buffer.from([1]),
          },
        ],
      }),
    ).rejects.toThrow(/offers no uploads/)
    expect(JSON.stringify(fake.requests)).not.toContain("Email/set")
  })

  it("moves, marks, and deletes into the Trash", async () => {
    const { mail, fake } = await backend()

    expect(await mail.moveEmails(["e2"], "archive")).toEqual({
      done: [{ id: "e2", previousId: "e2", mailboxId: "mb-archive" }],
      failed: [],
    })
    expect(
      (await mail.markEmails(["e1"], { read: true, flagged: true })).done[0]!
        .flags,
    ).toMatchObject({
      unread: false,
      flagged: true,
    })
    await mail.deleteEmails(["e1"])
    expect(fake.emails.find((email) => email.id === "e1")!.mailboxIds).toEqual({
      "mb-trash": true,
    })
    expect((await mail.moveEmails(["nope"], "inbox")).failed).toEqual([
      { id: "nope", error: "No email with that id." },
    ])
  })

  it("changes several emails in one Email/set, and says which it could not", async () => {
    const { mail, fake } = await backend()
    const before = fake.requests.length
    const moved = await mail.moveEmails(["e1", "e2", "nope", "e1"], "archive")

    expect(moved.done.map((entry) => entry.id)).toEqual(["e1", "e2"])
    expect(moved.failed).toEqual([
      { id: "nope", error: "No email with that id." },
    ])
    const sets = fake.requests
      .slice(before)
      .flatMap(
        (request) =>
          (request.body as { methodCalls?: Array<[string, unknown]> } | null)
            ?.methodCalls ?? [],
      )
      .filter(([name]) => name === "Email/set")
    expect(sets).toHaveLength(1)
  })

  it("adds and removes keywords, lowercased, and finds emails by them", async () => {
    const { mail, fake } = await backend()

    await mail.markEmails(["e1", "e3"], {
      addKeywords: ["Invoices", "a/b~c"],
      answered: true,
    })
    const marked = await mail.markEmails(["e3"], {
      removeKeywords: ["a/b~c"],
    })

    expect(marked.done[0]!.keywords).toEqual(["invoices"])
    expect(fake.emails.find((email) => email.id === "e1")!.keywords).toEqual({
      invoices: true,
      "a/b~c": true,
      $answered: true,
    })
    expect(
      (
        await mail.searchEmails({ keyword: "Invoices", offset: 0, limit: 10 })
      ).emails.map((email) => email.id),
    ).toEqual(["e3", "e1"])
    expect(
      (
        await mail.searchEmails({
          notKeyword: "invoices",
          offset: 0,
          limit: 10,
        })
      ).emails.map((email) => email.id),
    ).toEqual(["e2"])
  })

  it("searches every mailbox but Trash and Junk", async () => {
    const { mail, fake } = await backend()
    fake.emails.find((email) => email.id === "e2")!.mailboxIds = {
      "mb-archive": true,
    }
    fake.emails.find((email) => email.id === "e3")!.mailboxIds = {
      "mb-trash": true,
    }

    const found = await mail.searchEmails({
      allMailboxes: true,
      offset: 0,
      limit: 10,
    })

    expect(found.emails.map((email) => email.id)).toEqual(["e2", "e1"])
    const query = (
      fake.requests.at(-1)!.body as {
        methodCalls: Array<[string, { filter?: unknown }]>
      }
    ).methodCalls[0]![1]
    expect(query.filter).toEqual({ inMailboxOtherThan: ["mb-trash"] })
  })

  it("lists mailboxes with their paths", async () => {
    const { mail, fake } = await backend()
    fake.mailboxes.push(
      { id: "mb-clients", name: "Clients", role: null, parentId: null },
      { id: "mb-acme", name: "Acme", role: null, parentId: "mb-clients" },
    )
    const boxes = await mail.listMailboxes()

    expect(boxes.find((box) => box.id === "mb-acme")).toMatchObject({
      name: "Acme",
      path: "Clients/Acme",
      parentId: "mb-clients",
    })
    expect(boxes.find((box) => box.id === "mb-inbox")!.path).toBe("Inbox")
    expect(
      (
        await mail.searchEmails({
          mailbox: "clients/acme",
          offset: 0,
          limit: 5,
        })
      ).emails,
    ).toEqual([])
  })
})

describe("mailboxes", () => {
  it("creates one, inside another when asked", async () => {
    const { mail, fake } = await backend()
    const clients = await mail.createMailbox("Clients")
    const acme = await mail.createMailbox("Acme", "Clients")

    expect(clients).toMatchObject({ name: "Clients", path: "Clients" })
    expect(acme).toMatchObject({
      name: "Acme",
      path: "Clients/Acme",
      parentId: clients.id,
      totalEmails: 0,
    })
    expect(fake.mailboxes.map((box) => box.name)).toContain("Acme")
    await expect(mail.createMailbox("Acme", "Clients")).rejects.toThrow(
      /did not change the mailbox: invalidProperties/,
    )
  })

  it("renames and moves one, never into itself, and keeps the inbox at the top", async () => {
    const { mail } = await backend()
    const clients = await mail.createMailbox("Clients")
    const old = await mail.createMailbox("Old")

    expect(
      await mail.renameMailbox("Old", { name: "Past", parent: "Clients" }),
    ).toMatchObject({ id: old.id, path: "Clients/Past", parentId: clients.id })
    expect(
      await mail.renameMailbox("Clients/Past", { parent: null }),
    ).toMatchObject({ path: "Past", parentId: null })

    await mail.createMailbox("Inner", "Clients")
    await expect(
      mail.renameMailbox("Clients", { parent: "Clients/Inner" }),
    ).rejects.toThrow(/cannot go inside itself/)
    await expect(
      mail.renameMailbox("inbox", { parent: "Clients" }),
    ).rejects.toThrow(/inbox stays at the top/)
  })

  it("deletes only an empty mailbox, never a role's, and asks the server to keep its mail", async () => {
    const { mail, fake } = await backend()

    await expect(mail.deleteMailbox("trash")).rejects.toThrow(
      /trash mailbox; PCP does not delete it/,
    )
    await expect(mail.deleteMailbox("Archive")).rejects.toThrow(
      /archive mailbox/,
    )

    await mail.createMailbox("Full")
    await mail.moveEmails(["e2"], "Full")
    await expect(mail.deleteMailbox("Full")).rejects.toThrow(
      /holds 1 email; move or delete/,
    )

    await mail.createMailbox("Parent")
    await mail.createMailbox("Child", "Parent")
    await expect(mail.deleteMailbox("Parent")).rejects.toThrow(
      /mailboxes inside it/,
    )

    const child = await mail.deleteMailbox("Parent/Child")
    expect(child.name).toBe("Child")
    expect(fake.mailboxes.some((box) => box.id === child.id)).toBe(false)
    const destroy = (
      fake.requests.at(-1)!.body as {
        methodCalls: Array<[string, Record<string, unknown>]>
      }
    ).methodCalls[0]!
    expect(destroy).toEqual([
      "Mailbox/set",
      {
        accountId: "acct-1",
        destroy: [child.id],
        onDestroyRemoveEmails: false,
      },
      "b",
    ])
  })
})

describe("the automatic reply", () => {
  it("reads and sets it, with dates as UTCDates and null to clear", async () => {
    const { mail, fake } = await backend()

    expect(await mail.getVacationResponse!()).toEqual({
      enabled: false,
      from: null,
      to: null,
      subject: null,
      text: null,
    })
    expect(
      await mail.setVacationResponse!({
        enabled: true,
        from: "2026-10-10",
        to: "2026-10-20T18:00:00Z",
        text: "Away until the 20th.",
      }),
    ).toEqual({
      enabled: true,
      from: "2026-10-10T00:00:00Z",
      to: "2026-10-20T18:00:00Z",
      subject: null,
      text: "Away until the 20th.",
    })
    await mail.setVacationResponse!({ enabled: false, to: null })
    expect(fake.vacation).toMatchObject({
      isEnabled: false,
      fromDate: "2026-10-10T00:00:00Z",
      toDate: null,
      textBody: "Away until the 20th.",
    })
  })

  it("says so when the server has none", async () => {
    const { mail, session } = await backend({ vacation: false })

    expect(session.vacation).toBe(false)
    await expect(mail.getVacationResponse!()).rejects.toThrow(
      /VacationResponse\/get failed with unknownMethod/,
    )
  })
})

describe("attachments", () => {
  it("downloads an attachment of any kind, as its bytes", async () => {
    const { mail, fake } = await backend()

    expect(
      await mail.getAttachment("e1", "blob-csv", { maxBytes: 1000 }),
    ).toEqual({
      name: "parts.csv",
      type: "text/csv",
      size: 18,
      bytes: Buffer.from("part,count\ncog,42\n"),
      charset: null,
    })
    expect(fake.requests.at(-1)).toMatchObject({
      path: "/jmap/download/acct-1/blob-csv/parts.csv",
      authorization: BASIC,
    })

    const png = await mail.getAttachment("e1", "blob-png", { maxBytes: 1000 })
    expect(png).toMatchObject({
      name: "drawing.png",
      type: "image/png",
      size: 12,
    })
    expect(png.bytes.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    expect(fake.requests.at(-1)).toMatchObject({
      path: "/jmap/download/acct-1/blob-png/drawing.png",
    })

    await expect(
      mail.getAttachment("e1", "blob-csv", { maxBytes: 5 }),
    ).rejects.toThrow(/larger than/)
    await expect(
      mail.getAttachment("e2", "blob-csv", { maxBytes: 1000 }),
    ).rejects.toThrow(/no attachment with that id/)
  })

  it("sends the credential only to the mail server's own origin", async () => {
    const { fake, session } = await backend()

    for (const template of [
      "https://evil.example.com/{blobId}",
      "https:evil.example.com/{blobId}",
      "/jmap/download/{accountId}/{blobId}/{name}",
    ]) {
      const mail = openJmapBackend(
        { ...session, from: null, downloadUrl: template },
        basic(),
      )

      await expect(
        mail.getAttachment("e1", "blob-csv", { maxBytes: 1000 }),
      ).rejects.toThrow(/download address is not on the mail server/)
    }

    const mail = openJmapBackend(
      {
        ...session,
        from: null,
        uploadUrl: "https:evil.example.com/upload/{accountId}",
      },
      basic(),
    )

    await expect(
      mail.sendEmail!({
        to: [{ name: null, email: "x@example.com" }],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
        attachments: [
          {
            name: "a.bin",
            type: "application/octet-stream",
            bytes: Buffer.from([1]),
          },
        ],
      }),
    ).rejects.toThrow(/upload address is not on the mail server/)
    expect(fake.sent).toEqual([])
  })
})
