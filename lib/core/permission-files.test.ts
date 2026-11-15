import { describe, expect, it } from "vitest"

import {
  dispositionOf,
  fileLine,
  namedResultIds,
  previewOf,
  requestServes,
  servedFile,
  sizeLabel,
} from "./permission-files"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const PDF = Buffer.from("%PDF-1.7\n%…")

function result(kind: "text" | "bytes", mediaType: string, body: Buffer) {
  return {
    kind,
    mediaType,
    name: "file",
    text: () => body.toString("utf8"),
    bytes: () => body,
  }
}

describe("previewOf", () => {
  it("shows a PDF, the images a browser draws with no script, and text", () => {
    expect(previewOf("bytes", "application/pdf")).toBe("pdf")
    expect(previewOf("bytes", "image/PNG")).toBe("image")
    expect(previewOf("bytes", "image/webp")).toBe("image")
    expect(previewOf("bytes", "text/csv; charset=utf-8")).toBe("text")
    expect(previewOf("bytes", "application/json")).toBe("text")
    expect(previewOf("text", "text/plain")).toBe("text")
    // SVG and HTML are text, never drawn.
    expect(previewOf("bytes", "image/svg+xml")).toBe("text")
    expect(previewOf("bytes", "text/html")).toBe("text")
    expect(previewOf("bytes", "application/zip")).toBeNull()
  })
})

describe("namedResultIds", () => {
  it("finds handles and attachments at any depth, once each", () => {
    expect(
      namedResultIds({
        attachments: [{ $result: "a", name: "x.pdf", type: "application/pdf" }],
        deep: { list: [{ file: { $result: "b" } }, { $result: "a" }] },
        text: '{"$result": "c"}',
      }),
    ).toEqual(["a", "b"])
    expect(namedResultIds("nothing")).toEqual([])
  })
})

describe("requestServes", () => {
  const now = new Date("2026-11-05T12:00:00Z")
  const waiting = {
    kind: "call",
    status: "pending",
    expiresAt: new Date("2026-11-05T13:00:00Z"),
  }
  const args = { attachments: [{ $result: "r1" }] }

  it("serves a result a waiting call names", () => {
    expect(requestServes(waiting, args, "r1", now)).toBe(true)
  })

  it("serves nothing else", () => {
    expect(requestServes(waiting, args, "r2", now)).toBe(false)
    expect(requestServes(waiting, args, "", now)).toBe(false)
    expect(
      requestServes({ ...waiting, status: "declined" }, args, "r1", now),
    ).toBe(false)
    expect(
      requestServes({ ...waiting, status: "executed" }, args, "r1", now),
    ).toBe(false)
    expect(
      requestServes(
        { ...waiting, expiresAt: new Date("2026-11-05T11:59:59Z") },
        args,
        "r1",
        now,
      ),
    ).toBe(false)
    expect(
      requestServes({ ...waiting, kind: "register" }, args, "r1", now),
    ).toBe(false)
  })
})

describe("servedFile", () => {
  it("sends a PDF and an image as themselves, inline, when their bytes say so", () => {
    const pdf = servedFile(result("bytes", "application/pdf", PDF), {
      download: false,
    })
    expect(pdf.contentType).toBe("application/pdf")
    expect(pdf.disposition).toMatch(/^inline; /)
    expect(pdf.csp).toContain("frame-ancestors 'none'")

    const png = servedFile(result("bytes", "image/png", PNG), {
      download: false,
    })
    expect(png.contentType).toBe("image/png")
    expect(png.csp).toContain("sandbox")
    expect(png.body).toEqual(PNG)
  })

  it("sends a file whose bytes are not what it claims only as a download", () => {
    const html = Buffer.from("<script>alert(1)</script>")

    for (const type of ["application/pdf", "image/png"]) {
      const served = servedFile(result("bytes", type, html), {
        download: false,
      })
      expect(served.contentType).toBe("application/octet-stream")
      expect(served.disposition).toMatch(/^attachment; /)
    }
  })

  it("sends HTML, SVG and other text as plain text, sandboxed", () => {
    for (const type of ["text/html", "image/svg+xml", "text/csv"]) {
      const served = servedFile(
        result("bytes", type, Buffer.from("<svg onload=alert(1)>")),
        { download: false },
      )
      expect(served.contentType).toBe("text/plain; charset=utf-8")
      expect(served.csp).toContain("sandbox")
      expect(served.csp).toContain("default-src 'none'")
    }
  })

  it("sends anything else, and every download, as an attachment of no type", () => {
    expect(
      servedFile(result("bytes", "application/zip", PNG), { download: false })
        .contentType,
    ).toBe("application/octet-stream")

    const download = servedFile(result("bytes", "image/png", PNG), {
      download: true,
    })
    expect(download.contentType).toBe("application/octet-stream")
    expect(download.disposition).toMatch(/^attachment; /)
    expect(download.body).toEqual(PNG)
  })
})

describe("dispositionOf", () => {
  it("names the file in ASCII and UTF-8, with nothing that ends the header", () => {
    expect(dispositionOf("inline", 'résumé "1";.pdf')).toBe(
      `inline; filename="r_sum_ _1__.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%221%22%3B.pdf`,
    )
    expect(dispositionOf("attachment", "a\r\nb/../c")).toBe(
      `attachment; filename="ab_.._c"; filename*=UTF-8''ab_.._c`,
    )
    expect(dispositionOf("attachment", null)).toBe(
      `attachment; filename="file"; filename*=UTF-8''file`,
    )
  })
})

describe("sizeLabel and fileLine", () => {
  it("say a file's size as the owner reads it", () => {
    expect(sizeLabel("bytes", 8)).toBe("8 B")
    expect(sizeLabel("bytes", 12_595)).toBe("12.3 KB")
    expect(sizeLabel("bytes", 3 * 1024 * 1024)).toBe("3 MB")
    expect(sizeLabel("text", 1)).toBe("1 character")
    expect(sizeLabel("text", 1204)).toBe("1,204 characters")
  })

  it("tell the assistant what each file is, or that it is gone", () => {
    expect(
      fileLine({
        id: "r1",
        found: true,
        name: null,
        mediaType: "text/plain",
        kind: "text",
        length: 1204,
        size: "1,204 characters",
        from: "mail/get_attachment",
        expiresAt: new Date("2026-11-06T00:00:00Z"),
        preview: "text",
      }),
    ).toBe(
      "Kept result r1: (unnamed), text/plain, 1,204 characters, from mail/get_attachment, readable until 2026-11-06T00:00:00.000Z",
    )
    expect(fileLine({ id: "r2", found: false })).toBe(
      "Kept result r2: no longer available for this token; the call will fail",
    )
  })
})
