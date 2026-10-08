import { describe, expect, it } from "vitest"

import {
  formatMailServer,
  onSameOrigin,
  onSameOriginAbsolute,
  parseImapAddress,
  parseRecipient,
  parseSmtpAddress,
  validateSessionUrl,
} from "./addresses"

describe("validateSessionUrl", () => {
  it("takes an http(s) address as typed", () => {
    expect(
      validateSessionUrl(" https://mail.example.com/.well-known/jmap "),
    ).toBe("https://mail.example.com/.well-known/jmap")
  })

  it("refuses credentials, queries and other schemes", () => {
    expect(() =>
      validateSessionUrl("https://ada:pw@mail.example.com/jmap"),
    ).toThrow(/secret/)
    expect(() =>
      validateSessionUrl("https://mail.example.com/jmap?x=1"),
    ).toThrow(/query/)
    expect(() => validateSessionUrl("ftp://mail.example.com")).toThrow(/https/)
    expect(() => validateSessionUrl("not a url")).toThrow(/session URL/)
  })
})

describe("IMAP and SMTP addresses", () => {
  it("reads TLS and STARTTLS with their usual ports", () => {
    expect(parseImapAddress("imaps://mail.example.com")).toEqual({
      host: "mail.example.com",
      port: 993,
      secure: true,
    })
    expect(parseImapAddress("imap://mail.example.com")).toMatchObject({
      port: 143,
      secure: false,
    })
    expect(parseSmtpAddress("smtps://mail.example.com")).toMatchObject({
      port: 465,
      secure: true,
    })
    expect(parseSmtpAddress("smtp://mail.example.com:2525")).toMatchObject({
      port: 2525,
      secure: false,
    })
  })

  it("takes a bare host name as TLS", () => {
    expect(parseImapAddress("mail.example.com")).toEqual({
      host: "mail.example.com",
      port: 993,
      secure: true,
    })
    expect(parseImapAddress("[::1]:1993")).toEqual({
      host: "::1",
      port: 1993,
      secure: true,
    })
  })

  it("writes them back with the port spelled out", () => {
    expect(formatMailServer("imap", parseImapAddress("mail.example.com"))).toBe(
      "imaps://mail.example.com:993",
    )
    expect(formatMailServer("smtp", parseSmtpAddress("smtp://[::1]"))).toBe(
      "smtp://[::1]:587",
    )
  })

  it("refuses the wrong protocol, credentials and paths", () => {
    expect(() => parseImapAddress("https://mail.example.com")).toThrow(/imaps/)
    expect(() => parseImapAddress("smtps://mail.example.com")).toThrow(/imaps/)
    expect(() => parseImapAddress("imaps://ada:pw@mail.example.com")).toThrow(
      /secret/,
    )
    expect(() => parseImapAddress("imaps://mail.example.com/INBOX")).toThrow(
      /host and a port/,
    )
    expect(() => parseSmtpAddress("")).toThrow(/SMTP server/)
  })
})

describe("onSameOrigin", () => {
  const typed = "https://mail.example.com/.well-known/jmap"

  it("resolves an address on the typed origin", () => {
    expect(onSameOrigin("/jmap/", typed)).toBe("https://mail.example.com/jmap/")
    expect(onSameOrigin("https://mail.example.com/api", typed)).toBe(
      "https://mail.example.com/api",
    )
  })

  it("refuses another origin", () => {
    expect(onSameOrigin("https://api.example.com/jmap", typed)).toBeNull()
    expect(onSameOrigin("http://mail.example.com/jmap", typed)).toBeNull()
    expect(onSameOrigin("https://mail.example.com:8443/jmap", typed)).toBeNull()
    expect(onSameOrigin("https://x@mail.example.com/jmap", typed)).toBeNull()
  })
})

describe("onSameOriginAbsolute", () => {
  const typed = "https://mail.example.com/.well-known/jmap"

  it("takes an absolute address on the typed origin, as fetch will read it", () => {
    expect(onSameOriginAbsolute("https://mail.example.com/a#x", typed)).toBe(
      "https://mail.example.com/a",
    )
    expect(onSameOriginAbsolute("https:mail.example.com/a", typed)).toBe(
      "https://mail.example.com/a",
    )
  })

  it("refuses what is not absolute, or is on another origin", () => {
    expect(onSameOriginAbsolute("/jmap/", typed)).toBeNull()
    expect(onSameOriginAbsolute("https:evil.example.com/a", typed)).toBeNull()
    expect(onSameOriginAbsolute("https:\\evil.example.com/a", typed)).toBeNull()
    expect(
      onSameOriginAbsolute("https://x@mail.example.com/a", typed),
    ).toBeNull()
  })
})

describe("parseRecipient", () => {
  it("reads an address with or without a name", () => {
    expect(parseRecipient("ada@example.com")).toEqual({
      name: null,
      email: "ada@example.com",
    })
    expect(parseRecipient('"Ada Lovelace" <ada@example.com>')).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
  })

  it("lets nothing through that could start a header", () => {
    expect(() =>
      parseRecipient("ada@example.com\r\nBcc: eve@example.com"),
    ).toThrow(/line breaks/)
    expect(() => parseRecipient("not an address")).toThrow(/not an email/)
    expect(() => parseRecipient("a,b@example.com")).toThrow(/not an email/)
  })

  it("names a refused address by where it was, never by its text", () => {
    const secret = "hunter2-token-9f3a"
    const messages = [
      `${secret} is no address`,
      `${secret}\r\nBcc: eve@example.com`,
      `<${secret}"@example.com>`,
      `"Bad <Name>" <${secret}@example.com>`,
    ].map((raw) => {
      try {
        parseRecipient(raw, "Recipient 2 in to")
      } catch (error) {
        return (error as Error).message
      }
      return ""
    })

    for (const message of messages) {
      expect(message).toMatch(/^(Recipient 2 in to|The name in recipient 2)/)
      expect(message).not.toContain(secret)
    }
    expect(messages[0]).toBe("Recipient 2 in to is not an email address.")
  })
})
