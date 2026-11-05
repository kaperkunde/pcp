import { describe, expect, it } from "vitest"

import { fileShownWords } from "./call"
import { mediaTypeOf } from "./challenge"

// A tab that shows a PDF or a picture rather than a page: its main
// document's Content-Type, as Chromium reported it, says so, and the answer
// says how to read it (download, then the capability tools).

describe("a tab showing a file", () => {
  it("reads the main document's media type off its header", () => {
    expect(mediaTypeOf("application/PDF; qs=0.9")).toBe("application/pdf")
    expect(mediaTypeOf("image/png")).toBe("image/png")
    expect(mediaTypeOf(undefined)).toBeNull()
    expect(mediaTypeOf("not a type")).toBeNull()
  })

  it("offers download, then convert_document for a PDF and read_image for a picture", () => {
    expect(fileShownWords("t1", "application/pdf")).toMatch(
      /^Tab t1 shows a PDF.*download.*convert_document.*read_image/,
    )
    expect(fileShownWords("t1", "image/jpeg")).toMatch(
      /^Tab t1 shows a picture.*download.*read_image/,
    )
    expect(fileShownWords("t1", "text/html")).toBeNull()
    expect(fileShownWords("t1", null)).toBeNull()
  })
})
