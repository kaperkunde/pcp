import { describe, expect, it } from "vitest"

import { fileShownWords } from "./call"
import { mediaTypeOf } from "./challenge"
import { shownFileName } from "./downloads"

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

  it("names a file a page shows by its header, else its address, with its type's extension", () => {
    const at = "https://example.test/files/Statement%20March"
    expect(shownFileName(at, "application/pdf", undefined)).toBe(
      "Statement March.pdf",
    )
    expect(
      shownFileName(at, "application/pdf", 'inline; filename="invoice-7.pdf"'),
    ).toBe("invoice-7.pdf")
    expect(
      shownFileName(
        at,
        "application/pdf",
        "inline; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      ),
    ).toBe("résumé.pdf")
    expect(
      shownFileName("https://example.test/scan.png", "image/png", undefined),
    ).toBe("scan.png")
    // No name at all, and no path out of a name.
    expect(
      shownFileName("https://example.test/", "image/jpeg", undefined),
    ).toBe("picture.jpg")
    expect(
      shownFileName(at, "application/pdf", 'inline; filename="../../x"'),
    ).toBe(".._.._x.pdf")
  })
})
