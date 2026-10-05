import { describe, expect, it } from "vitest"

import { mailTools, mailToolSpec, parseMailArgs } from "./tools"

function names(options: Parameters<typeof mailTools>[0]): string[] {
  return mailTools(options).map((tool) => tool.name)
}

describe("mailTools", () => {
  it("gives a JMAP account that can send every tool", () => {
    expect(names({ kind: "jmap", readOnly: false, canSend: true })).toEqual([
      "list_mailboxes",
      "search_emails",
      "get_email",
      "get_attachment",
      "get_thread",
      "list_identities",
      "send_email",
      "move_email",
      "mark_email",
      "delete_email",
    ])
  })

  it("leaves out what IMAP has no use for, and sending without SMTP", () => {
    expect(names({ kind: "imap", readOnly: false, canSend: false })).toEqual([
      "list_mailboxes",
      "search_emails",
      "get_email",
      "get_attachment",
      "move_email",
      "mark_email",
      "delete_email",
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
    ).toThrow(/read, flagged/)
    expect(() =>
      parseMailArgs(mailToolSpec("send_email")!, "imap", {
        to: ["a@example.com"],
        subject: "x",
        text: "y",
        identity: "i1",
      }),
    ).toThrow(/identity/)
  })
})
