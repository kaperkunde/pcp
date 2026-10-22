import { describe, expect, it } from "vitest"

import { replyTarget } from "./addresses"
import { encodeImapId } from "./imap"
import {
  mailTools,
  mailToolSpec,
  parseMailArgs,
  parseRecipients,
} from "./tools"

function names(options: Parameters<typeof mailTools>[0]): string[] {
  return mailTools(options).map((tool) => tool.name)
}

describe("mailTools", () => {
  it("gives a JMAP account that can send every tool", () => {
    expect(
      names({
        kind: "jmap",
        readOnly: false,
        canSend: true,
        canVacation: true,
      }),
    ).toEqual([
      "list_mailboxes",
      "search_emails",
      "get_email",
      "get_attachment",
      "get_thread",
      "list_identities",
      "send_email",
      "create_draft",
      "move_email",
      "mark_email",
      "delete_email",
      "create_mailbox",
      "rename_mailbox",
      "delete_mailbox",
      "get_vacation_response",
      "set_vacation_response",
    ])
  })

  it("offers the automatic reply only where the JMAP server has one", () => {
    expect(
      names({ kind: "jmap", readOnly: false, canSend: true }),
    ).not.toContain("get_vacation_response")
    expect(
      names({
        kind: "imap",
        readOnly: false,
        canSend: true,
        canVacation: true,
      }),
    ).not.toContain("get_vacation_response")
    expect(
      names({
        kind: "jmap",
        readOnly: true,
        canSend: false,
        canVacation: true,
      }),
    ).toEqual([
      "list_mailboxes",
      "search_emails",
      "get_email",
      "get_attachment",
      "get_thread",
      "get_vacation_response",
    ])
  })

  it("counts the automatic reply as sending: left out where the account cannot send", () => {
    const options = {
      kind: "jmap",
      readOnly: false,
      canVacation: true,
    } as const

    expect(names({ ...options, canSend: false })).not.toContain(
      "set_vacation_response",
    )
    // Reading it sends nothing.
    expect(names({ ...options, canSend: false })).toContain(
      "get_vacation_response",
    )
    expect(names({ ...options, canSend: true })).toContain(
      "set_vacation_response",
    )

    const set = mailTools({ ...options, canSend: true }).find(
      (tool) => tool.name === "set_vacation_response",
    )!
    expect(set.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    })
    expect(set.description).toMatch(/sends this text to whoever writes/)
    expect(mailToolSpec("set_vacation_response")).toMatchObject({
      writes: true,
      sends: true,
    })
    expect(mailToolSpec("get_vacation_response")!.sends).toBeUndefined()
  })

  it("leaves out what IMAP has no use for, and sending without SMTP", () => {
    expect(names({ kind: "imap", readOnly: false, canSend: false })).toEqual([
      "list_mailboxes",
      "search_emails",
      "get_email",
      "get_attachment",
      // A draft needs no SMTP server.
      "create_draft",
      "move_email",
      "mark_email",
      "delete_email",
      "create_mailbox",
      "rename_mailbox",
      "delete_mailbox",
    ])
  })

  it("gives a read-only account the reading tools only", () => {
    expect(names({ kind: "jmap", readOnly: true, canSend: true })).toEqual([
      "list_mailboxes",
      "search_emails",
      "get_email",
      "get_attachment",
      "get_thread",
      "list_identities",
    ])
    for (const name of [
      "create_draft",
      "create_mailbox",
      "rename_mailbox",
      "delete_mailbox",
    ]) {
      expect(
        names({ kind: "imap", readOnly: true, canSend: true }),
      ).not.toContain(name)
    }
  })

  it("takes a draft as send_email takes an email, with recipients optional", () => {
    const tools = mailTools({ kind: "jmap", readOnly: false, canSend: true })
    const send = tools.find((tool) => tool.name === "send_email")!
    const draft = tools.find((tool) => tool.name === "create_draft")!
    const properties = (schema: unknown) =>
      Object.keys((schema as { properties: object }).properties)

    expect(properties(draft.inputSchema)).toEqual(properties(send.inputSchema))
    expect(draft.inputSchema).toMatchObject({
      type: "object",
      required: ["subject", "text"],
      additionalProperties: false,
    })
    expect(draft.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    })
    expect(mailToolSpec("create_draft")).toMatchObject({ writes: true })
    expect(mailToolSpec("create_draft")!.sends).toBeUndefined()
  })

  it("describes arguments as JSON Schema, and marks what changes mail", () => {
    const tools = mailTools({ kind: "imap", readOnly: false, canSend: true })
    const send = tools.find((tool) => tool.name === "send_email")!

    expect(send.inputSchema).toMatchObject({
      type: "object",
      required: ["to", "subject", "text"],
      additionalProperties: false,
    })
    expect(
      (send.inputSchema as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty("identity")
    expect(send.inputSchema).not.toHaveProperty("$schema")
    expect(
      tools.find((tool) => tool.name === "delete_email")!.annotations,
    ).toMatchObject({
      destructiveHint: true,
    })
    expect(
      tools.find((tool) => tool.name === "get_email")!.annotations,
    ).toMatchObject({
      readOnlyHint: true,
    })
    expect(
      tools.find((tool) => tool.name === "delete_mailbox")!.annotations,
    ).toMatchObject({ destructiveHint: true })
    expect(
      tools.find((tool) => tool.name === "create_mailbox")!.annotations,
    ).toMatchObject({ destructiveHint: false })
  })
})

describe("parseMailArgs", () => {
  it("accepts what the schema allows", () => {
    expect(
      parseMailArgs(mailToolSpec("search_emails")!, "jmap", {
        text: "invoice",
        after: "2026-10-01",
        limit: 5,
      }),
    ).toEqual({ text: "invoice", after: "2026-10-01", limit: 5 })
  })

  it("refuses unknown arguments, bad dates and empty marks, naming the tool", () => {
    expect(() =>
      parseMailArgs(mailToolSpec("get_email")!, "jmap", {
        id: "1",
        extra: true,
      }),
    ).toThrow(/get_email: .*extra/)
    expect(() =>
      parseMailArgs(mailToolSpec("search_emails")!, "imap", { after: "soon" }),
    ).toThrow(/2026-10-01/)
    expect(() =>
      parseMailArgs(mailToolSpec("mark_email")!, "imap", { id: "1" }),
    ).toThrow(/read, flagged, answered, addKeywords/)
    expect(() =>
      parseMailArgs(mailToolSpec("send_email")!, "imap", {
        to: ["a@example.com"],
        subject: "x",
        text: "y",
        identity: "i1",
      }),
    ).toThrow(/identity/)
  })

  it("checks a draft against send_email's limits", () => {
    const spec = mailToolSpec("create_draft")!

    expect(parseMailArgs(spec, "imap", { subject: "", text: "" })).toEqual({
      subject: "",
      text: "",
    })
    expect(() =>
      parseMailArgs(spec, "jmap", {
        to: Array.from({ length: 51 }, (_, n) => `a${n}@example.com`),
        subject: "s",
        text: "t",
      }),
    ).toThrow(/create_draft: .*to/)
    expect(() =>
      parseMailArgs(spec, "jmap", {
        subject: "s",
        text: "t",
        attachments: [{ $result: "r1", name: "../evil" }],
      }),
    ).toThrow(/file name/)
    expect(() =>
      parseMailArgs(spec, "imap", { subject: "x".repeat(501), text: "" }),
    ).toThrow(/create_draft/)
    expect(() =>
      parseMailArgs(spec, "imap", { subject: "s", text: "t", identity: "i1" }),
    ).toThrow(/identity/)
  })
})

describe("recipients", () => {
  const send = mailToolSpec("send_email")!

  it("takes addresses written out, as {name, email} objects, or both mixed", () => {
    const args = parseMailArgs(send, "imap", {
      to: [
        { name: "Charles Babbage", email: "charles@example.com" },
        "Ada Lovelace <ada@example.com>",
      ],
      cc: [{ name: null, email: "news@example.com" }, "x@example.com"],
      bcc: [{ email: "archive@example.com" }],
      subject: "s",
      text: "t",
    })

    expect(parseRecipients(args.to, "to")).toEqual([
      { name: "Charles Babbage", email: "charles@example.com" },
      { name: "Ada Lovelace", email: "ada@example.com" },
    ])
    expect(parseRecipients(args.cc, "cc")).toEqual([
      { name: null, email: "news@example.com" },
      { name: null, email: "x@example.com" },
    ])
    expect(parseRecipients(args.bcc, "bcc")).toEqual([
      { name: null, email: "archive@example.com" },
    ])
  })

  it("takes back what get_email gives, an empty name included", () => {
    expect(
      parseRecipients([{ name: "", email: " ada@example.com " }], "to"),
    ).toEqual([{ name: null, email: "ada@example.com" }])
  })

  it("refuses an object with other fields, no email, or a bad one", () => {
    for (const to of [
      [{ name: "Ada", email: "ada@example.com", address: "x" }],
      [{ name: "Ada" }],
      [{ email: 42 }],
      [{ name: "x".repeat(201), email: "ada@example.com" }],
    ]) {
      expect(() =>
        parseMailArgs(send, "jmap", { to, subject: "s", text: "t" }),
      ).toThrow(/send_email: .*to/)
    }

    // The schema has the shape; the address itself is checked after.
    expect(() =>
      parseRecipients([{ name: "Ada", email: "not an address" }], "to"),
    ).toThrow("Recipient 1 in to is not an email address.")
    expect(() =>
      parseRecipients(
        ["ada@example.com", { name: "Eve\r\nBcc: eve", email: "e@x.com" }],
        "cc",
      ),
    ).toThrow("Recipient 2 in cc cannot have line breaks")
    expect(() =>
      parseRecipients([{ name: "<Eve>", email: "e@example.com" }], "to"),
    ).toThrow(/cannot have <, > or quotes/)
  })

  it("still counts at most 50, objects or not", () => {
    expect(() =>
      parseMailArgs(send, "jmap", {
        to: Array.from({ length: 51 }, (_, n) => ({
          email: `a${n}@example.com`,
        })),
        subject: "s",
        text: "t",
      }),
    ).toThrow(/send_email: .*to/)
  })

  it("says in the schema that both forms are taken", () => {
    const tool = mailTools({
      kind: "jmap",
      readOnly: false,
      canSend: true,
    }).find((candidate) => candidate.name === "send_email")!
    const to = (
      tool.inputSchema as {
        properties: Record<string, { description?: string; items?: unknown }>
      }
    ).properties.to!

    expect(to.description).toMatch(/\{"name": "Ada Lovelace", "email"/)
    expect(to.items).toMatchObject({
      anyOf: [
        { type: "string" },
        {
          type: "object",
          required: ["email"],
          additionalProperties: false,
        },
      ],
    })
  })
})

describe("inReplyTo", () => {
  const draft = mailToolSpec("create_draft")!
  const reply = (inReplyTo: unknown) =>
    parseMailArgs(draft, "imap", { subject: "s", text: "t", inReplyTo })

  it("takes an email's id or its Message-ID, with or without brackets", () => {
    for (const value of [
      "e1",
      "1.7.SU5CT1g",
      "<engine-1@example.com>",
      "engine-1@example.com",
      "CAF=x+y_z.1@mail.gmail.com",
    ]) {
      expect(reply(value)).toMatchObject({ inReplyTo: value })
    }
  })

  it("refuses what is neither", () => {
    for (const value of [
      "<e1>",
      "<a@example.com",
      "a b@example.com",
      "<a@example.com> <b@example.com>",
      "a@b@example.com",
      "a@example.com\r\nBcc: eve@example.com",
      "",
    ]) {
      expect(() => reply(value)).toThrow(/create_draft: .*inReplyTo/)
    }
  })

  it("tells them apart by shape", () => {
    expect(replyTarget("e1")).toEqual({ id: "e1" })
    expect(replyTarget(encodeImapId(1, 7n, "INBOX"))).toEqual({
      id: encodeImapId(1, 7n, "INBOX"),
    })
    expect(replyTarget("<engine-1@example.com>")).toEqual({
      messageId: "engine-1@example.com",
    })
    expect(replyTarget(" engine-1@example.com ")).toEqual({
      messageId: "engine-1@example.com",
    })
    expect(replyTarget("<e1>")).toBeNull()
  })

  it("is described as taking both", () => {
    const tool = mailTools({
      kind: "imap",
      readOnly: false,
      canSend: true,
    }).find((candidate) => candidate.name === "send_email")!

    expect(
      (
        tool.inputSchema as {
          properties: Record<string, { description?: string }>
        }
      ).properties.inReplyTo!.description,
    ).toBe(
      "The email this replies to: its id as search_emails returns it, or its Message-ID header (as get_email's messageId).",
    )
  })
})

describe("several emails at once", () => {
  it("takes id or ids, never both or neither, and at most 100", () => {
    const spec = mailToolSpec("move_email")!

    expect(
      parseMailArgs(spec, "jmap", { id: "e1", mailbox: "archive" }),
    ).toEqual({ id: "e1", mailbox: "archive" })
    expect(
      parseMailArgs(spec, "jmap", { ids: ["e1", "e2"], mailbox: "archive" }),
    ).toEqual({ ids: ["e1", "e2"], mailbox: "archive" })

    for (const name of ["move_email", "mark_email", "delete_email"]) {
      const args = { mailbox: "archive", read: true }
      const pick = (extra: object) =>
        Object.fromEntries(
          Object.entries({ ...args, ...extra }).filter(([key]) =>
            name === "move_email"
              ? key !== "read"
              : name === "mark_email"
                ? key !== "mailbox"
                : key === "id" || key === "ids",
          ),
        )

      expect(() =>
        parseMailArgs(mailToolSpec(name)!, "imap", pick({})),
      ).toThrow(/id for one email, or ids/)
      expect(() =>
        parseMailArgs(
          mailToolSpec(name)!,
          "imap",
          pick({ id: "1", ids: ["2"] }),
        ),
      ).toThrow(/id for one email, or ids/)
      expect(() =>
        parseMailArgs(mailToolSpec(name)!, "imap", pick({ ids: [] })),
      ).toThrow(name)
      expect(() =>
        parseMailArgs(
          mailToolSpec(name)!,
          "imap",
          pick({ ids: Array.from({ length: 101 }, (_, n) => `e${n}`) }),
        ),
      ).toThrow(name)
    }
  })
})

describe("keywords", () => {
  const mark = mailToolSpec("mark_email")!

  it("takes keywords to add and remove, and answered", () => {
    expect(
      parseMailArgs(mark, "jmap", {
        id: "e1",
        answered: true,
        addKeywords: ["Invoices", "$label1"],
        removeKeywords: ["todo"],
      }),
    ).toEqual({
      id: "e1",
      answered: true,
      addKeywords: ["Invoices", "$label1"],
      removeKeywords: ["todo"],
    })
  })

  it("refuses a keyword IMAP or JMAP would not take, and the ones flags set", () => {
    for (const bad of [
      "two words",
      "a(b",
      "x*",
      'q"',
      "back\\slash",
      "é",
      "",
    ]) {
      expect(() =>
        parseMailArgs(mark, "imap", { id: "1", addKeywords: [bad] }),
      ).toThrow(/mark_email/)
    }

    for (const flag of ["$seen", "$Flagged", "$answered", "$draft"]) {
      expect(() =>
        parseMailArgs(mark, "jmap", { id: "1", removeKeywords: [flag] }),
      ).toThrow(/read, flagged or answered/)
    }

    expect(() =>
      parseMailArgs(mark, "jmap", {
        id: "1",
        addKeywords: Array.from({ length: 21 }, (_, n) => `k${n}`),
      }),
    ).toThrow(/mark_email/)
    expect(() =>
      parseMailArgs(mailToolSpec("search_emails")!, "jmap", {
        keyword: "a b",
      }),
    ).toThrow(/search_emails/)
  })
})

describe("searching", () => {
  it("searches every mailbox or one, never both", () => {
    const spec = mailToolSpec("search_emails")!

    expect(parseMailArgs(spec, "jmap", { allMailboxes: true })).toEqual({
      allMailboxes: true,
    })
    expect(() =>
      parseMailArgs(spec, "jmap", { allMailboxes: true, mailbox: "inbox" }),
    ).toThrow(/not both/)
  })
})

describe("mailbox tools", () => {
  it("takes a plain name, inside a parent when one is given", () => {
    const create = mailToolSpec("create_mailbox")!

    expect(
      parseMailArgs(create, "imap", { name: "Acme", parent: "Clients" }),
    ).toEqual({ name: "Acme", parent: "Clients" })

    for (const name of ["", "a/b", " padded", "tab\there", "x".repeat(201)]) {
      expect(() => parseMailArgs(create, "jmap", { name })).toThrow(
        /create_mailbox/,
      )
    }
  })

  it("renames to a new name, a new parent or the top, and needs one of them", () => {
    const rename = mailToolSpec("rename_mailbox")!

    expect(
      parseMailArgs(rename, "jmap", { mailbox: "Old", parent: null }),
    ).toEqual({ mailbox: "Old", parent: null })
    expect(() => parseMailArgs(rename, "jmap", { mailbox: "Old" })).toThrow(
      /new name, a new parent/,
    )
  })

  it("sets the automatic reply with dates it can read, and null to clear", () => {
    const set = mailToolSpec("set_vacation_response")!

    expect(
      parseMailArgs(set, "jmap", {
        enabled: true,
        from: "2026-10-10",
        to: null,
        text: "Away",
      }),
    ).toEqual({ enabled: true, from: "2026-10-10", to: null, text: "Away" })
    expect(() => parseMailArgs(set, "jmap", { text: "Away" })).toThrow(
      /enabled/,
    )
    expect(() =>
      parseMailArgs(set, "jmap", { enabled: true, from: "someday" }),
    ).toThrow(/2026-10-01/)
  })
})
