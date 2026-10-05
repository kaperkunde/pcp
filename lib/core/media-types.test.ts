import { describe, expect, it } from "vitest"

import {
  bareType,
  charsetOf,
  decodeText,
  isTextBytes,
  isTextType,
  sniffMediaType,
} from "./media-types"

describe("isTextType", () => {
  it("takes text types, structured suffixes and the listed applications", () => {
    for (const type of [
      "text/plain",
      "text/csv; charset=utf-8",
      "application/json",
      "application/vnd.api+json",
      "image/svg+xml",
      "application/xml",
      "message/rfc822",
    ]) {
      expect(isTextType(type), type).toBe(true)
    }
  })

  it("refuses binary types", () => {
    for (const type of ["image/png", "application/pdf", "application/zip"]) {
      expect(isTextType(type), type).toBe(false)
    }
  })

  it("drops parameters and case", () => {
    expect(bareType("Text/CSV ; charset=x")).toBe("text/csv")
  })
})

describe("charsetOf and decodeText", () => {
  it("reads a quoted or bare charset", () => {
    expect(charsetOf('text/csv; charset="iso-8859-1"')).toBe("iso-8859-1")
    expect(charsetOf("text/csv;charset=utf-8")).toBe("utf-8")
    expect(charsetOf("text/csv")).toBeNull()
  })

  it("decodes with the charset, and falls back to UTF-8 for an unknown one", () => {
    expect(decodeText(Uint8Array.from([0xe9]), "iso-8859-1")).toBe("é")
    expect(decodeText(Buffer.from("héllo"), "no-such-charset")).toBe("héllo")
    expect(decodeText(Buffer.from("héllo"), null)).toBe("héllo")
  })
})

describe("isTextBytes", () => {
  it("accepts UTF-8 text with tabs and line breaks", () => {
    expect(isTextBytes(Buffer.from("a\tb\r\nc é"))).toBe(true)
  })

  it("refuses control characters and invalid UTF-8", () => {
    expect(isTextBytes(Buffer.from("a\u0000b"))).toBe(false)
    expect(isTextBytes(Uint8Array.from([0xff, 0xfe, 0x00]))).toBe(false)
  })
})

describe("sniffMediaType", () => {
  it("names a file by its first bytes", () => {
    const cases: Array<[number[], string]> = [
      [[0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], "application/pdf"],
      [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0], "image/png"],
      [[0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
      [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
      [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], "image/gif"],
      [[0x50, 0x4b, 0x03, 0x04, 0], "application/zip"],
    ]

    for (const [bytes, type] of cases) {
      expect(sniffMediaType(Uint8Array.from(bytes))).toBe(type)
    }
  })

  it("answers null for anything else, and for too few bytes", () => {
    expect(sniffMediaType(Buffer.from("hello"))).toBeNull()
    expect(sniffMediaType(Uint8Array.from([0x89, 0x50]))).toBeNull()
    expect(sniffMediaType(new Uint8Array())).toBeNull()
  })
})
