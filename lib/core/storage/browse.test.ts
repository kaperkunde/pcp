import { describe, expect, it } from "vitest"

import {
  bytesLabel,
  contentRange,
  LOCKED_CSP,
  parseRange,
  previewOfName,
  servedPreview,
  sniffStoreFile,
} from "./browse"

const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === "string"
        ? [...value].map((char) => char.charCodeAt(0))
        : [value],
    ),
  )

const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)
const PDF = bytes("%PDF-1.7\n")
const MP4 = bytes(0, 0, 0, 0x20, "ftypisom", 0, 0)
const MP3 = bytes("ID3", 4, 0, 0)
const OGG = bytes("OggS", 0, 2)
const WAV = bytes("RIFF", 0, 0, 0, 0, "WAVEfmt ")
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg">')

describe("previewOfName", () => {
  it("previews images, PDFs, text, sounds and videos by extension", () => {
    expect(previewOfName("photo.JPG")).toBe("image")
    expect(previewOfName("scan.webp")).toBe("image")
    expect(previewOfName("invoice.pdf")).toBe("pdf")
    expect(previewOfName("notes.md")).toBe("text")
    expect(previewOfName("data.csv")).toBe("text")
    expect(previewOfName("answer.json")).toBe("text")
    expect(previewOfName("song.mp3")).toBe("audio")
    expect(previewOfName("clip.webm")).toBe("video")
  })

  it("shows SVG and HTML as text, never rendered", () => {
    expect(previewOfName("logo.svg")).toBe("text")
    expect(previewOfName("page.html")).toBe("text")
  })

  it("offers none for other files or no extension", () => {
    expect(previewOfName("archive.zip")).toBeNull()
    expect(previewOfName("README")).toBeNull()
    expect(previewOfName(".hidden")).toBeNull()
    expect(previewOfName("report.docx")).toBeNull()
  })
})

describe("sniffStoreFile", () => {
  it("names what media-types knows and the sounds it does not", () => {
    expect(sniffStoreFile(PNG)).toBe("image/png")
    expect(sniffStoreFile(MP4)).toBe("video/mp4")
    expect(sniffStoreFile(MP3)).toBe("audio/mpeg")
    expect(sniffStoreFile(bytes(0xff, 0xfb, 0x90, 0))).toBe("audio/mpeg")
    expect(sniffStoreFile(OGG)).toBe("audio/ogg")
    expect(sniffStoreFile(bytes("fLaC", 0))).toBe("audio/flac")
    expect(sniffStoreFile(WAV)).toBe("audio/wav")
    expect(sniffStoreFile(SVG)).toBeNull()
  })
})

describe("servedPreview", () => {
  it("serves text as plain text, whatever it holds", () => {
    expect(servedPreview("text", SVG)).toEqual({
      contentType: "text/plain; charset=utf-8",
      csp: LOCKED_CSP,
    })
    expect(servedPreview("text", new Uint8Array())).not.toBeNull()
  })

  it("serves an image as itself only when its bytes say so", () => {
    expect(servedPreview("image", PNG)).toEqual({
      contentType: "image/png",
      csp: LOCKED_CSP,
    })
    // An SVG renamed .png is not shown as an image.
    expect(servedPreview("image", SVG)).toBeNull()
    expect(servedPreview("image", PDF)).toBeNull()
  })

  it("serves a PDF to the browser's viewer, unsandboxed but not framed", () => {
    expect(servedPreview("pdf", PDF)).toEqual({
      contentType: "application/pdf",
      csp: "frame-ancestors 'none'",
    })
    expect(servedPreview("pdf", PNG)).toBeNull()
  })

  it("serves sounds and videos by their bytes, loading only from PCP", () => {
    const sound = servedPreview("audio", MP3)
    expect(sound?.contentType).toBe("audio/mpeg")
    expect(sound?.csp).toContain("media-src 'self'")
    expect(sound?.csp).toContain("sandbox")
    expect(servedPreview("audio", MP4)?.contentType).toBe("video/mp4")
    expect(servedPreview("video", MP4)?.contentType).toBe("video/mp4")
    expect(servedPreview("video", MP3)).toBeNull()
  })

  it("serves nothing inline for a file with no preview", () => {
    expect(servedPreview(null, PNG)).toBeNull()
  })
})

describe("parseRange", () => {
  it("serves the whole file without a header or with one it does not take", () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange("", 100)).toBeNull()
    expect(parseRange("items=0-10", 100)).toBeNull()
    expect(parseRange("bytes=0-1, 5-6", 100)).toBeNull()
    expect(parseRange("bytes=-", 100)).toBeNull()
    expect(parseRange("bytes=10-5", 100)).toBeNull()
    expect(parseRange("bytes=abc-", 100)).toBeNull()
    expect(parseRange("bytes=1234567890123456-", 100)).toBeNull()
  })

  it("reads first-last, an open end and a suffix", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 })
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 })
    expect(parseRange("bytes=95-500", 100)).toEqual({ offset: 95, length: 5 })
    expect(parseRange("bytes=-20", 100)).toEqual({ offset: 80, length: 20 })
    expect(parseRange("bytes=-500", 100)).toEqual({ offset: 0, length: 100 })
    expect(parseRange(" Bytes = 0 - 0 ", 100)).toEqual({
      offset: 0,
      length: 1,
    })
  })

  it("refuses a range past the end", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable")
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable")
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable")
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable")
  })
})

describe("contentRange", () => {
  it("names the part served, or the size alone", () => {
    expect(contentRange({ offset: 10, length: 5 }, 100)).toBe("bytes 10-14/100")
    expect(contentRange(null, 100)).toBe("bytes */100")
  })
})

describe("bytesLabel", () => {
  it("names bytes in the largest unit under 1024", () => {
    expect(bytesLabel(812)).toBe("812 B")
    expect(bytesLabel(1536)).toBe("1.5 KB")
    expect(bytesLabel(12.3 * 1024 * 1024)).toBe("12.3 MB")
    expect(bytesLabel(3 * 1024 ** 3)).toBe("3 GB")
  })
})
