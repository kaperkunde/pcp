import { describe, expect, it } from "vitest"

import { mailTools, mailToolSpec, parseMailArgs } from "./tools"

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
