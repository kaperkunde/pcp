import { afterEach, describe, expect, it } from "vitest"

import { startTestApi, type TestApi } from "../openapi/test-api"
import { createFakeJmap, type FakeJmap } from "./fake-jmap"
import { fetchJmapSession, jmapRequest, openJmapBackend } from "./jmap"
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
      accountId: "acct-1",
      submission: true,
    })
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      path: "/jmap/session",
      authorization: BASIC,
    })
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

  it("moves, marks, and deletes into the Trash", async () => {
    const { mail, fake } = await backend()

    expect(await mail.moveEmail("e2", "archive")).toEqual({
      id: "e2",
      previousId: "e2",
      mailboxId: "mb-archive",
    })
    expect(
      (await mail.markEmail("e1", { read: true, flagged: true })).flags,
    ).toMatchObject({
      unread: false,
      flagged: true,
    })
    await mail.deleteEmail("e1")
    expect(fake.emails.find((email) => email.id === "e1")!.mailboxIds).toEqual({
      "mb-trash": true,
    })
    await expect(mail.moveEmail("nope", "inbox")).rejects.toThrow(
      /No email with that id/,
    )
  })

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
})
