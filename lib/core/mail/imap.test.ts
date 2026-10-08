import { Readable } from "node:stream"

import type { FetchMessageObject, MessageStructureObject } from "imapflow"
import { describe, expect, it } from "vitest"

import {
  checkImapAccount,
  decodeImapId,
  defaultImapDeps,
  encodeImapId,
  mailboxRole,
  openImapBackend,
  pickParts,
  type ImapClientLike,
  type ImapConfig,
  type ImapDeps,
  type OutgoingMail,
} from "./imap"
import { MailAuthError, MailRequestError, MailTransportError } from "./types"

// The IMAP backend against an in-memory stand-in for imapflow and
// nodemailer: what PCP asks the libraries for, and what it makes of it.

type StoredMessage = {
  uid: number
  flags: Set<string>
  internalDate: Date
  envelope: FetchMessageObject["envelope"]
  bodyStructure: MessageStructureObject
  parts: Record<string, string>
  headers?: string
}

type Box = {
  uidValidity: bigint
  uidNext: number
  specialUse?: string
  /** A mailbox that only holds others (\\Noselect). */
  noselect?: boolean
  messages: StoredMessage[]
}

const ALTERNATIVE: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    {
      type: "multipart/alternative",
      part: "1",
      childNodes: [
        {
          type: "text/plain",
          part: "1.1",
          parameters: { charset: "utf-8" },
          size: 40,
        },
        { type: "text/html", part: "1.2", size: 80 },
      ],
    },
    {
      type: "text/csv",
      part: "2",
      disposition: "attachment",
      dispositionParameters: { filename: "parts.csv" },
      size: 18,
    },
    {
      type: "application/pdf",
      part: "3",
      disposition: "attachment",
      dispositionParameters: { filename: "plan.pdf" },
      size: 9000,
    },
  ],
}

function world(): Map<string, Box> {
  return new Map<string, Box>([
    [
      "INBOX",
      {
        uidValidity: 7n,
        uidNext: 4,
        messages: [
          {
            uid: 1,
            flags: new Set(),
            internalDate: new Date("2026-10-01T09:00:00Z"),
            envelope: {
              subject: "The engine",
              messageId: "<engine-1@example.com>",
              from: [
                { name: "Charles Babbage", address: "charles@example.com" },
              ],
              to: [{ name: "Ada", address: "ada@example.com" }],
            },
            bodyStructure: ALTERNATIVE,
            parts: {
              "1.1": "Shall we meet about the engine on Thursday?",
              "1.2": "<p>Shall we <b>meet</b>?</p>",
              "2": "part,count\ncog,42\n",
              "3": "%PDF-1.7",
            },
            headers: "References: <older@example.com>\r\n\r\n",
          },
          {
            uid: 2,
            flags: new Set(["\\Seen", "\\Flagged"]),
            internalDate: new Date("2026-10-02T09:00:00Z"),
            envelope: {
              subject: "Newsletter",
              from: [{ address: "news@example.com" }],
            },
            bodyStructure: { type: "text/html", size: 60 },
            parts: {
              "1": '<p>Read <a href="https://example.com/n">the news</a>.</p>',
            },
          },
          {
            uid: 3,
            flags: new Set(["\\Seen"]),
            internalDate: new Date("2026-10-03T09:00:00Z"),
            envelope: {
              subject: "Long",
              from: [{ address: "charles@example.com" }],
            },
            bodyStructure: { type: "text/plain", size: 5000 },
            parts: { "1": "x".repeat(5000) },
          },
        ],
      },
    ],
    [
      "Sent",
      { uidValidity: 8n, uidNext: 1, specialUse: "\\Sent", messages: [] },
    ],
    [
      "Trash",
      { uidValidity: 9n, uidNext: 1, specialUse: "\\Trash", messages: [] },
    ],
    ["Archive/2026", { uidValidity: 10n, uidNext: 1, messages: [] }],
  ])
}

function fakeImap(
  boxes: Map<string, Box>,
  {
    secure = true,
    capabilities = ["IMAP4rev1", "MOVE", "UIDPLUS"],
  }: { secure?: boolean; capabilities?: string[] } = {},
): ImapClientLike & {
  calls: string[]
  appended: Array<{ path: string; raw: string; flags?: string[] }>
} {
  let open: string | null = null
  const calls: string[] = []
  const appended: Array<{ path: string; raw: string; flags?: string[] }> = []
  const current = () => boxes.get(open!)!
  const find = (uid: string) =>
    current().messages.find((message) => message.uid === Number(uid))
  /** The messages a UID set names: "1", or "1,3". */
  const findAll = (range: string) =>
    range.split(",").flatMap((uid) => {
      const message = find(uid)
      return message ? [message] : []
    })
  const view = (message: StoredMessage): FetchMessageObject => ({
    seq: 1,
    uid: message.uid,
    flags: new Set(message.flags),
    envelope: message.envelope,
    bodyStructure: message.bodyStructure,
    internalDate: message.internalDate,
    size: 100,
    headers: Buffer.from(message.headers ?? ""),
  })

  return {
    calls,
    appended,
    secureConnection: secure,
    capabilities: new Map(capabilities.map((name) => [name, true])),
    get mailbox() {
      return open ? { path: open, uidValidity: current().uidValidity } : false
    },
    async logout() {
      calls.push("logout")
    },
    close() {
      calls.push("close")
    },
    async list() {
      return [...boxes.entries()].map(([path, box]) => ({
        path,
        name: path.split("/").at(-1)!,
        delimiter: "/",
        parentPath: path.includes("/")
          ? path.split("/").slice(0, -1).join("/")
          : "",
        flags: new Set<string>(box.noselect ? ["\\Noselect"] : []),
        specialUse: box.specialUse,
        status: {
          messages: box.messages.length,
          unseen: box.messages.filter((m) => !m.flags.has("\\Seen")).length,
        },
      }))
    },
    async getMailboxLock(path, options) {
      if (!boxes.has(path)) {
        throw Object.assign(new Error("no mailbox"), { mailboxMissing: true })
      }
      open = path
      calls.push(`lock ${path}${options?.readOnly ? " read-only" : ""}`)
      return { path, release: () => calls.push(`release ${path}`) }
    },
    async search(criteria) {
      calls.push(`search ${JSON.stringify(criteria)}`)
      return current()
        .messages.filter((m) =>
          criteria.seen === undefined
            ? true
            : m.flags.has("\\Seen") === criteria.seen,
        )
        .filter((m) =>
          criteria.text
            ? (m.envelope?.subject ?? "").includes(criteria.text)
            : true,
        )
        .filter((m) =>
          criteria.keyword ? m.flags.has(criteria.keyword) : true,
        )
        .filter((m) =>
          criteria.unKeyword ? !m.flags.has(criteria.unKeyword) : true,
        )
        .map((m) => m.uid)
    },
    async fetchAll(range) {
      const uids = new Set((range as number[]).map(Number))
      return current()
        .messages.filter((m) => uids.has(m.uid))
        .map(view)
    },
    async fetchOne(uid) {
      const message = find(uid)
      return message ? view(message) : false
    },
    async download(uid, part, { maxBytes }) {
      calls.push(`download ${uid} ${part}`)
      const text = find(uid)?.parts[part ?? "1"] ?? ""
      return {
        meta: { expectedSize: Buffer.byteLength(text) },
        content: Readable.from([Buffer.from(text).subarray(0, maxBytes + 10)]),
      }
    },
    async messageMove(range, destination) {
      calls.push(`move ${range} ${destination}`)
      const messages = findAll(range)
      if (messages.length === 0) return false
      const target = boxes.get(destination)!
      const uidMap = new Map<number, number>()
      for (const message of messages) {
        current().messages.splice(current().messages.indexOf(message), 1)
        const newUid = target.uidNext++
        target.messages.push({ ...message, uid: newUid })
        uidMap.set(message.uid, newUid)
      }
      return { uidMap, uidValidity: target.uidValidity }
    },
    async messageFlagsAdd(range, flags) {
      calls.push(`add ${range} ${flags.join(" ")}`)
      findAll(range).forEach((m) => flags.forEach((flag) => m.flags.add(flag)))
      return true
    },
    async messageFlagsRemove(range, flags) {
      calls.push(`remove ${range} ${flags.join(" ")}`)
      findAll(range).forEach((m) =>
        flags.forEach((flag) => m.flags.delete(flag)),
      )
      return true
    },
    async mailboxCreate(path) {
      calls.push(`create ${path}`)
      if (boxes.has(path)) return { path, created: false }
      boxes.set(path, { uidValidity: 20n, uidNext: 1, messages: [] })
      return { path, created: true }
    },
    async mailboxRename(path, newPath) {
      calls.push(`rename ${path} ${newPath}`)
      for (const [key, box] of [...boxes.entries()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          boxes.delete(key)
          boxes.set(newPath + key.slice(path.length), box)
        }
      }
      return { path, newPath }
    },
    async mailboxDelete(path) {
      calls.push(`delete ${path}`)
      boxes.delete(path)
      return { path }
    },
    async append(path, raw, flags) {
      appended.push({ path, raw: raw.toString("utf8"), flags })
      const box = boxes.get(path)!
      return { uid: box.uidNext++, uidValidity: box.uidValidity }
    },
  }
}

const LOGIN = { username: "ada@example.com", password: "app-password" }
const CONFIG: ImapConfig = {
  imap: { host: "mail.example.com", port: 993, secure: true },
  smtp: { host: "mail.example.com", port: 465, secure: true },
  from: null,
}

function setup(
  options: {
    boxes?: Map<string, Box>
    config?: Partial<ImapConfig>
    secure?: boolean
    capabilities?: string[]
    connect?: ImapDeps["connect"]
    rejected?: string[]
    verify?: () => Promise<unknown>
  } = {},
) {
  const boxes = options.boxes ?? world()
  const imap = fakeImap(boxes, {
    secure: options.secure,
    capabilities: options.capabilities,
  })
  const mailed: OutgoingMail[] = []
  const deps: ImapDeps = {
    connect: options.connect ?? (async () => imap),
    smtp: async () => ({
      async sendMail(mail) {
        mailed.push(mail)
        return {
          messageId: mail.messageId,
          accepted: mail.to.map((t) => t.address),
          rejected: options.rejected ?? [],
        }
      },
      verify: options.verify ?? (async () => true),
      close() {},
    }),
    compose: async (mail) =>
      Buffer.from(`Subject: ${mail.subject}\r\n\r\n${mail.text}`),
  }
  const config = { ...CONFIG, ...options.config }

  return {
    boxes,
    imap,
    mailed,
    deps,
    config,
    mail: openImapBackend(config, LOGIN, deps),
  }
}

describe("pieces", () => {
  it("knows mailbox roles from SPECIAL-USE and the inbox by name", () => {
    expect(mailboxRole({ path: "INBOX" })).toBe("inbox")
    expect(mailboxRole({ path: "Sent Items", specialUse: "\\Sent" })).toBe(
      "sent",
    )
    expect(
      mailboxRole({
        path: "Bin",
        flags: new Set(["\\HasNoChildren", "\\Trash"]),
      }),
    ).toBe("trash")
    expect(mailboxRole({ path: "Projects" })).toBeNull()
  })

  it("makes ids that say where an email is", () => {
    const id = encodeImapId(42, 1234567890123n, "Archive/2026 – Q4")
    expect(decodeImapId(id)).toEqual({
      uid: 42,
      uidValidity: 1234567890123n,
      path: "Archive/2026 – Q4",
    })
    expect(() => decodeImapId("e1")).toThrow(MailRequestError)
  })

  it("picks the text, the HTML and the attachments from a structure", () => {
    expect(pickParts(ALTERNATIVE)).toMatchObject({
      text: { part: "1.1" },
      html: { part: "1.2" },
      attachments: [
        { part: "2", name: "parts.csv", type: "text/csv", size: 18 },
        { part: "3", name: "plan.pdf", type: "application/pdf", size: 9000 },
      ],
    })
    expect(pickParts({ type: "text/plain" })).toMatchObject({
      text: { part: "1" },
      html: null,
      attachments: [],
    })
  })
})

describe("reading", () => {
  it("lists mailboxes with roles and counts", async () => {
    const { mail } = setup()

    expect(await mail.listMailboxes()).toEqual([
      {
        id: "INBOX",
        name: "INBOX",
        path: "INBOX",
        role: "inbox",
        parentId: null,
        totalEmails: 3,
        unreadEmails: 1,
      },
      {
        id: "Sent",
        name: "Sent",
        path: "Sent",
        role: "sent",
        parentId: null,
        totalEmails: 0,
        unreadEmails: 0,
      },
      {
        id: "Trash",
        name: "Trash",
        path: "Trash",
        role: "trash",
        parentId: null,
        totalEmails: 0,
        unreadEmails: 0,
      },
      {
        id: "Archive/2026",
        name: "2026",
        path: "Archive/2026",
        role: null,
        parentId: "Archive",
        totalEmails: 0,
        unreadEmails: 0,
      },
    ])
  })

  it("searches the inbox newest first, read-only, with paging", async () => {
    const { mail, imap } = setup()

    const all = await mail.searchEmails({ offset: 0, limit: 20 })
    expect(all.total).toBe(3)
    expect(all.emails.map((email) => decodeImapId(email.id).uid)).toEqual([
      3, 2, 1,
    ])
    expect(all.emails[2]).toMatchObject({
      from: [{ name: "Charles Babbage", email: "charles@example.com" }],
      flags: { unread: true, flagged: false },
      hasAttachments: true,
      mailboxIds: ["INBOX"],
      date: "2026-10-01T09:00:00.000Z",
    })
    expect(imap.calls).toContain("lock INBOX read-only")
    expect(imap.calls).toContain('search {"all":true}')

    const unread = await mail.searchEmails({
      unread: true,
      offset: 0,
      limit: 5,
    })
    expect(unread.emails).toHaveLength(1)
    expect(imap.calls).toContain('search {"seen":false}')

    const page = await mail.searchEmails({ offset: 1, limit: 1 })
    expect(page.emails.map((email) => decodeImapId(email.id).uid)).toEqual([2])
  })

  it("reads the text part, the HTML made plain when that is all, and lists attachments", async () => {
    const { mail } = setup()
    const id = (uid: number) => encodeImapId(uid, 7n, "INBOX")

    const plain = await mail.getEmail(id(1), { bodyBytes: 10_000 })
    expect(plain).toMatchObject({
      subject: "The engine",
      messageId: "engine-1@example.com",
      references: ["older@example.com"],
      body: {
        text: "Shall we meet about the engine on Thursday?",
        source: "text",
        truncated: false,
      },
      attachments: [
        { id: "2", name: "parts.csv", type: "text/csv", size: 18 },
        { id: "3", name: "plan.pdf", type: "application/pdf", size: 9000 },
      ],
    })

    const html = await mail.getEmail(id(2), { bodyBytes: 10_000 })
    expect(html.body).toEqual({
      text: "Read the news (https://example.com/n).",
      source: "html",
      truncated: false,
    })

    const long = await mail.getEmail(id(3), { bodyBytes: 100 })
    expect(long.body.truncated).toBe(true)
    expect(long.body.text).toHaveLength(100)
  })

  it("refuses an id from before its mailbox changed", async () => {
    const { mail } = setup()

    await expect(
      mail.getEmail(encodeImapId(1, 6n, "INBOX"), { bodyBytes: 100 }),
    ).rejects.toThrow(/before its mailbox changed/)
    await expect(
      mail.getEmail(encodeImapId(1, 7n, "Gone"), { bodyBytes: 100 }),
    ).rejects.toThrow(/not there any more/)
  })

  it("downloads attachments of any kind, as their bytes", async () => {
    const { mail, imap } = setup()
    const id = encodeImapId(1, 7n, "INBOX")

    expect(await mail.getAttachment(id, "2", { maxBytes: 1000 })).toEqual({
      name: "parts.csv",
      type: "text/csv",
      size: 18,
      bytes: Buffer.from("part,count\ncog,42\n"),
      charset: "utf-8",
    })
    expect(
      await mail.getAttachment(id, "3", { maxBytes: 100_000 }),
    ).toMatchObject({
      name: "plan.pdf",
      charset: null,
    })
    expect(imap.calls.filter((call) => call.startsWith("download"))).toEqual([
      "download 1 2",
      "download 1 3",
    ])
    await expect(
      mail.getAttachment(id, "1.1", { maxBytes: 1000 }),
    ).rejects.toThrow(/no attachment with that id/)
  })
})

describe("changing", () => {
  it("moves an email and gives its new id", async () => {
    const { mail, boxes } = setup()
    const moved = await mail.moveEmails(
      [encodeImapId(2, 7n, "INBOX")],
      "Archive/2026",
    )

    expect(moved).toEqual({
      done: [
        {
          id: encodeImapId(1, 10n, "Archive/2026"),
          previousId: encodeImapId(2, 7n, "INBOX"),
          mailboxId: "Archive/2026",
        },
      ],
      failed: [],
    })
    expect(boxes.get("Archive/2026")!.messages).toHaveLength(1)
  })

  it("moves several at once, a mailbox at a time, and says which it could not", async () => {
    const boxes = world()
    boxes.get("Sent")!.messages.push({
      ...boxes.get("INBOX")!.messages[0]!,
      uid: 5,
      flags: new Set(["\\Seen"]),
    })
    const { mail, imap } = setup({ boxes })
    const moved = await mail.moveEmails(
      [
        encodeImapId(1, 7n, "INBOX"),
        encodeImapId(3, 7n, "INBOX"),
        encodeImapId(5, 8n, "Sent"),
        encodeImapId(99, 7n, "INBOX"),
        encodeImapId(1, 6n, "INBOX"),
        "not-an-id",
      ],
      "Archive/2026",
    )

    expect(moved.done.map((entry) => entry.previousId)).toEqual([
      encodeImapId(1, 7n, "INBOX"),
      encodeImapId(3, 7n, "INBOX"),
      encodeImapId(5, 8n, "Sent"),
    ])
    expect(moved.done.map((entry) => entry.id)).toEqual([
      encodeImapId(1, 10n, "Archive/2026"),
      encodeImapId(2, 10n, "Archive/2026"),
      encodeImapId(3, 10n, "Archive/2026"),
    ])
    expect(moved.failed).toEqual([
      { id: "not-an-id", error: expect.stringMatching(/not an email id/) },
      { id: encodeImapId(99, 7n, "INBOX"), error: "No email with that id." },
      {
        id: encodeImapId(1, 6n, "INBOX"),
        error: expect.stringMatching(/before its mailbox changed/),
      },
    ])
    // One MOVE per mailbox, not one per email.
    expect(imap.calls.filter((call) => call.startsWith("move"))).toEqual([
      "move 1,3 Archive/2026",
      "move 5 Archive/2026",
    ])
  })

  it("marks an email read and flagged", async () => {
    const { mail } = setup()
    const marked = await mail.markEmails([encodeImapId(1, 7n, "INBOX")], {
      read: true,
      flagged: true,
    })

    expect(marked.done[0]!.flags).toMatchObject({
      unread: false,
      flagged: true,
    })
  })

  it("adds and removes keywords, lowercased, and answers with them", async () => {
    const { mail, imap } = setup()
    const ids = [encodeImapId(1, 7n, "INBOX"), encodeImapId(2, 7n, "INBOX")]

    await mail.markEmails(ids, { addKeywords: ["Invoices", "todo"] })
    const marked = await mail.markEmails(ids, {
      answered: true,
      removeKeywords: ["todo"],
    })

    expect(marked.done.map((email) => email.keywords)).toEqual([
      ["invoices"],
      ["invoices"],
    ])
    expect(marked.done[0]!.flags.answered).toBe(true)
    expect(imap.calls).toContain("add 1,2 invoices todo")
    expect(imap.calls).toContain("remove 1,2 todo")

    const found = await mail.searchEmails({
      keyword: "invoices",
      offset: 0,
      limit: 10,
    })
    expect(found.emails).toHaveLength(2)
    expect(imap.calls).toContain('search {"keyword":"invoices"}')
  })

  it("refuses to move or delete where that would erase other deleted mail", async () => {
    // Neither MOVE nor UIDPLUS: imapflow would copy, flag and plain EXPUNGE.
    const { mail, imap, boxes } = setup({ capabilities: ["IMAP4rev1"] })
    const id = encodeImapId(1, 7n, "INBOX")

    for (const run of [
      () => mail.moveEmails([id], "Archive/2026"),
      () => mail.deleteEmails([id]),
    ]) {
      expect(await run()).toEqual({
        done: [],
        failed: [
          {
            id,
            error: expect.stringMatching(/neither move mail.*erase every/),
          },
        ],
      })
    }

    expect(imap.calls.some((call) => call.startsWith("move"))).toBe(false)
    expect(boxes.get("INBOX")!.messages).toHaveLength(3)

    // Either one is enough: MOVE alone, or UIDPLUS for a UID EXPUNGE.
    for (const capabilities of [
      ["IMAP4rev1", "MOVE"],
      ["IMAP4rev1", "UIDPLUS"],
      ["IMAP4rev2"],
    ]) {
      const { mail: ok } = setup({ capabilities })

      expect((await ok.moveEmails([id], "Archive/2026")).failed).toEqual([])
    }
  })

  it("deletes into the Trash only", async () => {
    const { mail, boxes } = setup()
    const moved = await mail.deleteEmails([encodeImapId(1, 7n, "INBOX")])

    expect(moved.done[0]!.mailboxId).toBe("Trash")
    expect((await mail.deleteEmails([moved.done[0]!.id!])).failed).toEqual([
      {
        id: moved.done[0]!.id,
        error: expect.stringMatching(/in the Trash already/),
      },
    ])

    const noTrash = world()
    noTrash.delete("Trash")
    await expect(
      setup({ boxes: noTrash }).mail.deleteEmails([
        encodeImapId(1, 7n, "INBOX"),
      ]),
    ).rejects.toThrow(/no Trash mailbox/)
    expect(boxes.get("INBOX")!.messages).toHaveLength(2)
  })
})

describe("mailboxes", () => {
  it("creates one at the top or inside another", async () => {
    const { mail, imap, boxes } = setup()

    expect(await mail.createMailbox("Clients")).toMatchObject({
      id: "Clients",
      name: "Clients",
      parentId: null,
      totalEmails: 0,
    })
    expect(await mail.createMailbox("Acme", "Clients")).toMatchObject({
      id: "Clients/Acme",
      parentId: "Clients",
    })
    expect(boxes.has("Clients/Acme")).toBe(true)
    expect(imap.calls).toContain("create Clients/Acme")

    await expect(mail.createMailbox("Acme", "Clients")).rejects.toThrow(
      /already/,
    )
    await expect(mail.createMailbox("a/b")).rejects.toThrow(/cannot hold "\/"/)
    await expect(mail.createMailbox("x", "Nowhere")).rejects.toThrow(
      /No mailbox called Nowhere/,
    )
  })

  it("renames one and moves it, never into itself, and never the inbox", async () => {
    const { mail, boxes } = setup()
    await mail.createMailbox("Clients")

    expect(
      await mail.renameMailbox("Archive/2026", { name: "Old" }),
    ).toMatchObject({ id: "Archive/Old", name: "Old" })
    expect(
      await mail.renameMailbox("Archive/Old", { parent: "Clients" }),
    ).toMatchObject({ id: "Clients/Old", parentId: "Clients" })
    expect(
      await mail.renameMailbox("Clients/Old", { parent: null }),
    ).toMatchObject({ id: "Old", parentId: null })
    expect(boxes.has("Old")).toBe(true)

    await mail.createMailbox("Inner", "Clients")
    await expect(
      mail.renameMailbox("Clients", { parent: "Clients/Inner" }),
    ).rejects.toThrow(/cannot go inside itself/)
    await expect(mail.renameMailbox("INBOX", { name: "In" })).rejects.toThrow(
      /inbox keeps/,
    )
  })

  it("deletes only an empty mailbox with no role and nothing inside it", async () => {
    const { mail, imap, boxes } = setup()

    await expect(mail.deleteMailbox("Trash")).rejects.toThrow(
      /trash mailbox; PCP does not delete it/,
    )
    await expect(mail.deleteMailbox("INBOX")).rejects.toThrow(/inbox mailbox/)

    await mail.createMailbox("Full")
    boxes.get("Full")!.messages.push(boxes.get("INBOX")!.messages[0]!)
    await expect(mail.deleteMailbox("Full")).rejects.toThrow(
      /holds 1 email; move or delete/,
    )

    await mail.createMailbox("Parent")
    await mail.createMailbox("Child", "Parent")
    await expect(mail.deleteMailbox("Parent")).rejects.toThrow(
      /mailboxes inside it/,
    )

    expect(await mail.deleteMailbox("Parent/Child")).toMatchObject({
      id: "Parent/Child",
    })
    expect(boxes.has("Parent/Child")).toBe(false)
    expect(imap.calls.filter((call) => call.startsWith("delete"))).toEqual([
      "delete Parent/Child",
    ])
  })
})

describe("searching every mailbox", () => {
  it("merges the newest from each, leaving out Trash, Junk and folders that hold none", async () => {
    const boxes = world()
    boxes.get("Archive/2026")!.messages.push({
      ...boxes.get("INBOX")!.messages[0]!,
      uid: 1,
      internalDate: new Date("2026-10-02T12:00:00Z"),
      envelope: { subject: "Archived" },
    })
    boxes.get("Trash")!.messages.push({
      ...boxes.get("INBOX")!.messages[0]!,
      uid: 1,
      internalDate: new Date("2026-10-05T12:00:00Z"),
      envelope: { subject: "Binned" },
    })
    boxes.set("Archive", {
      uidValidity: 11n,
      uidNext: 1,
      noselect: true,
      messages: [],
    })
    const { mail, imap } = setup({ boxes })
    const found = await mail.searchEmails({
      allMailboxes: true,
      offset: 0,
      limit: 3,
    })

    expect(found.emails.map((email) => email.subject)).toEqual([
      "Long",
      "Archived",
      "Newsletter",
    ])
    expect(found.total).toBe(4)
    expect(imap.calls.filter((call) => call.startsWith("lock"))).toEqual([
      "lock INBOX read-only",
      "lock Sent read-only",
      "lock Archive/2026 read-only",
    ])

    await expect(
      mail.searchEmails({ allMailboxes: true, offset: 490, limit: 20 }),
    ).rejects.toThrow(/pages only to 500/)
  })

  it("searches only All Mail where the server has one, so no email comes twice", async () => {
    const boxes = world()
    boxes.set("[Gmail]/All Mail", {
      uidValidity: 12n,
      uidNext: 2,
      specialUse: "\\All",
      messages: [{ ...boxes.get("INBOX")!.messages[0]!, uid: 1 }],
    })
    const { mail, imap } = setup({ boxes })
    const found = await mail.searchEmails({
      allMailboxes: true,
      offset: 0,
      limit: 10,
    })

    expect(found.total).toBe(1)
    expect(imap.calls.filter((call) => call.startsWith("lock"))).toEqual([
      "lock [Gmail]/All Mail read-only",
    ])
  })
})

describe("sending", () => {
  it("sends over SMTP as the user name, into the conversation, and files a copy in Sent", async () => {
    const { mail, mailed, imap, boxes } = setup()

    const sent = await mail.sendEmail!({
      to: [{ name: "Charles Babbage", email: "charles@example.com" }],
      cc: [],
      bcc: [{ name: null, email: "archive@example.com" }],
      subject: "Re: The engine",
      text: "Thursday suits me.",
      inReplyTo: encodeImapId(1, 7n, "INBOX"),
    })

    expect(mailed).toHaveLength(1)
    expect(mailed[0]).toMatchObject({
      from: { address: "ada@example.com" },
      to: [{ name: "Charles Babbage", address: "charles@example.com" }],
      bcc: [{ name: "", address: "archive@example.com" }],
      inReplyTo: "<engine-1@example.com>",
      references: ["<older@example.com>", "<engine-1@example.com>"],
    })
    expect(mailed[0]!.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)
    expect(imap.appended).toEqual([
      {
        path: "Sent",
        raw: "Subject: Re: The engine\r\n\r\nThursday suits me.",
        flags: ["\\Seen"],
      },
    ])
    expect(sent).toMatchObject({
      id: encodeImapId(1, 8n, "Sent"),
      savedTo: "Sent",
      from: { email: "ada@example.com" },
      answered: true,
    })
    expect(sent.messageId).toBe(mailed[0]!.messageId.slice(1, -1))
    // The email it answers is marked answered, as a mail app would.
    const original = boxes
      .get("INBOX")!
      .messages.find((message) => message.uid === 1)!
    expect(original.flags.has("\\Answered")).toBe(true)
  })

  it("says so when the email it answers cannot be marked, and the email still goes", async () => {
    const { mail, mailed, imap } = setup()
    imap.messageFlagsAdd = async () => false

    const sent = await mail.sendEmail!({
      to: [{ name: null, email: "charles@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: The engine",
      text: "Thursday suits me.",
      inReplyTo: encodeImapId(1, 7n, "INBOX"),
    })

    expect(mailed).toHaveLength(1)
    expect(sent).toMatchObject({ savedTo: "Sent", answered: false })
  })

  it("sends attachments over SMTP and in the Sent copy alike", async () => {
    const { mail, mailed } = setup()
    const pdf = Buffer.from("%PDF-1.7 the plan")

    await mail.sendEmail!({
      to: [{ name: null, email: "x@example.com" }],
      cc: [],
      bcc: [],
      subject: "The plan",
      text: "Attached.",
      attachments: [{ name: "plan.pdf", type: "application/pdf", bytes: pdf }],
    })

    expect(mailed[0]!.attachments).toEqual([
      { filename: "plan.pdf", contentType: "application/pdf", content: pdf },
    ])
  })

  it("sends from the From address when the user name is not one", async () => {
    const { mail, mailed } = setup({ config: { from: "ada@example.org" } })
    await mail.sendEmail!({
      to: [{ name: null, email: "x@example.com" }],
      cc: [],
      bcc: [],
      subject: "s",
      text: "t",
    })

    expect(mailed[0]!.from?.address).toBe("ada@example.org")
  })

  it("cannot send without an SMTP server", () => {
    expect(setup({ config: { smtp: null } }).mail.sendEmail).toBeUndefined()
  })

  it("says which recipients the server refused", async () => {
    const { mail } = setup({ rejected: ["nobody@example.com"] })

    await expect(
      mail.sendEmail!({
        to: [{ name: null, email: "nobody@example.com" }],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/refused nobody@example.com/)
  })

  it("writes the Sent copy with Bcc kept, and the reply headers", async () => {
    const raw = (
      await defaultImapDeps.compose({
        from: { name: "", address: "ada@example.com" },
        to: [{ name: "Charles", address: "charles@example.com" }],
        cc: [],
        bcc: [{ name: "", address: "archive@example.com" }],
        subject: "Re: The engine",
        text: "Thursday suits me.",
        messageId: "<m1@example.com>",
        inReplyTo: "<engine-1@example.com>",
        references: ["<engine-1@example.com>"],
      })
    ).toString("utf8")

    expect(raw).toMatch(/^Bcc: archive@example.com$/m)
    expect(raw).toMatch(/^In-Reply-To: <engine-1@example.com>$/m)
    expect(raw).toMatch(/^Message-ID: <m1@example.com>$/m)
    expect(raw).toContain("Thursday suits me.")
  })

  it("writes attachments into the message with their name and type", async () => {
    const raw = (
      await defaultImapDeps.compose({
        from: { name: "", address: "ada@example.com" },
        to: [{ name: "", address: "charles@example.com" }],
        cc: [],
        bcc: [],
        subject: "Parts",
        text: "Attached.",
        messageId: "<m2@example.com>",
        attachments: [
          {
            filename: "parts.csv",
            contentType: "text/csv",
            content: Buffer.from("part,count\ncog,42\n"),
          },
        ],
      })
    ).toString("utf8")

    expect(raw).toMatch(/^Content-Type: multipart\/mixed;/m)
    expect(raw).toMatch(/^Content-Type: text\/csv; name=parts\.csv$/m)
    expect(raw).toMatch(
      /^Content-Disposition: attachment; filename=parts\.csv$/m,
    )
    expect(raw).toContain(
      Buffer.from("part,count\ncog,42\n").toString("base64"),
    )
  })
})

describe("drafting", () => {
  function withDrafts(specialUse: string | undefined = "\\Drafts") {
    const boxes = world()
    boxes.set("Drafts", {
      uidValidity: 11n,
      uidNext: 1,
      ...(specialUse ? { specialUse } : {}),
      messages: [],
    })
    return boxes
  }

  it("appends a draft to Drafts with the Draft flag, and sends nothing", async () => {
    const { mail, mailed, imap, boxes, deps } = setup({ boxes: withDrafts() })
    const composed: OutgoingMail[] = []
    const compose = deps.compose
    deps.compose = async (mail) => {
      composed.push(mail)
      return compose(mail)
    }
    const pdf = Buffer.from("%PDF-1.7 the plan")

    const draft = await mail.createDraft({
      to: [{ name: "Charles Babbage", email: "charles@example.com" }],
      cc: [],
      bcc: [{ name: null, email: "archive@example.com" }],
      subject: "Re: The engine",
      text: "Thursday suits me.",
      inReplyTo: encodeImapId(1, 7n, "INBOX"),
      attachments: [{ name: "plan.pdf", type: "application/pdf", bytes: pdf }],
    })

    expect(mailed).toEqual([])
    expect(imap.appended).toEqual([
      {
        path: "Drafts",
        raw: "Subject: Re: The engine\r\n\r\nThursday suits me.",
        flags: ["\\Draft", "\\Seen"],
      },
    ])
    expect(composed).toEqual([
      expect.objectContaining({
        from: { name: "", address: "ada@example.com" },
        to: [{ name: "Charles Babbage", address: "charles@example.com" }],
        bcc: [{ name: "", address: "archive@example.com" }],
        inReplyTo: "<engine-1@example.com>",
        references: ["<older@example.com>", "<engine-1@example.com>"],
        attachments: [
          {
            filename: "plan.pdf",
            contentType: "application/pdf",
            content: pdf,
          },
        ],
      }),
    ])
    expect(draft).toMatchObject({
      id: encodeImapId(1, 11n, "Drafts"),
      from: { email: "ada@example.com" },
      mailboxId: "Drafts",
      mailbox: "Drafts",
    })
    expect(`<${draft.messageId}>`).toBe(composed[0]!.messageId)
    // A draft answers nothing yet.
    const original = boxes
      .get("INBOX")!
      .messages.find((message) => message.uid === 1)!
    expect(original.flags.has("\\Answered")).toBe(false)
  })

  it("finds Drafts by name, and needs neither SMTP, a From address nor UIDPLUS", async () => {
    const { imap, deps, config } = setup({
      boxes: withDrafts(undefined),
      config: { smtp: null },
    })
    imap.append = async (path, raw, flags) => {
      imap.appended.push({ path, raw: raw.toString("utf8"), flags })
      return {}
    }
    const composed: OutgoingMail[] = []
    deps.compose = async (mail) => {
      composed.push(mail)
      return Buffer.from(mail.text)
    }
    const mail = openImapBackend(
      config,
      { username: "ada", password: "app-password" },
      deps,
    )

    expect(mail.sendEmail).toBeUndefined()
    const draft = await mail.createDraft({
      to: [],
      cc: [],
      bcc: [],
      subject: "Notes",
      text: "To finish later.",
    })

    expect(draft).toMatchObject({ id: null, from: null, mailboxId: "Drafts" })
    expect(composed[0]).not.toHaveProperty("from")
    expect(composed[0]!.messageId).toMatch(/@pcp\.invalid>$/)
    expect(imap.appended).toEqual([
      { path: "Drafts", raw: "To finish later.", flags: ["\\Draft", "\\Seen"] },
    ])
  })

  it("writes nothing when the account has no Drafts mailbox", async () => {
    const { mail, imap } = setup()

    await expect(
      mail.createDraft({ to: [], cc: [], bcc: [], subject: "s", text: "t" }),
    ).rejects.toThrow(/no Drafts mailbox/)
    expect(imap.appended).toEqual([])
  })

  it("writes a message with no From or To at all", async () => {
    const raw = (
      await defaultImapDeps.compose({
        to: [],
        cc: [],
        bcc: [],
        subject: "Notes",
        text: "To finish later.",
        messageId: "<m3@pcp.invalid>",
      })
    ).toString("utf8")

    expect(raw).not.toMatch(/^From:/m)
    expect(raw).not.toMatch(/^To:/m)
    expect(raw).toMatch(/^Subject: Notes$/m)
    expect(raw).toContain("To finish later.")
  })
})

describe("failures", () => {
  it("tells refused credentials from an unreachable server", async () => {
    const refused = setup({
      connect: async () => {
        throw Object.assign(new Error("Authentication failed"), {
          authenticationFailed: true,
        })
      },
    })
    await expect(refused.mail.listMailboxes()).rejects.toBeInstanceOf(
      MailAuthError,
    )

    const down = setup({
      connect: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        })
      },
    })
    await expect(down.mail.listMailboxes()).rejects.toThrow(
      /IMAP server could not be reached: ECONNREFUSED/,
    )
  })

  it("will not use a connection that is not encrypted", async () => {
    const { mail, imap } = setup({ secure: false })

    await expect(mail.listMailboxes()).rejects.toBeInstanceOf(
      MailTransportError,
    )
    expect(imap.calls).toContain("close")
  })

  it("checks the SMTP login along with the IMAP one", async () => {
    const { config, deps } = setup({
      verify: async () => {
        throw Object.assign(new Error("Invalid login"), {
          code: "EAUTH",
          responseCode: 535,
        })
      },
    })

    await expect(checkImapAccount(config, LOGIN, deps)).rejects.toBeInstanceOf(
      MailAuthError,
    )
  })

  it("logs out when done", async () => {
    const { mail, imap } = setup()
    await mail.listMailboxes()
    await mail.close()

    expect(imap.calls.at(-1)).toBe("logout")
  })
})
