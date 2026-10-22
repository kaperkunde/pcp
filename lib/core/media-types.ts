/**
 * Media types and bytes: which kept results and attachments are text, how
 * their bytes become one, and what a binary one is by its first bytes.
 */

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/sql",
  "application/csv",
  "application/ics",
  "message/rfc822",
])

/** The media type without its parameters, lowercased. */
export function bareType(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase()
}

export function isTextType(type: string): boolean {
  const bare = bareType(type)

  return (
    bare.startsWith("text/") ||
    bare.endsWith("+json") ||
    bare.endsWith("+xml") ||
    TEXT_TYPES.has(bare)
  )
}

/** The charset a media type names, if it names one. */
export function charsetOf(type: string): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(type)
  return match ? match[1]! : null
}

/** Bytes as text in the charset given, or UTF-8 when it is unknown. */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      // A charset TextDecoder does not know: UTF-8 is the best guess.
    }
  }

  return new TextDecoder("utf-8").decode(bytes)
}

/** Control characters other than tab and line breaks: binary, not text. */
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Whether bytes are UTF-8 text with nothing binary in it. */
export function isTextBytes(bytes: Uint8Array): boolean {
  let text: string

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return false
  }

  return !NOT_TEXT.test(text)
}

const SIGNATURES: Array<{ type: string; bytes: number[] }> = [
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  {
    type: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { type: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
]

/** Whether `text` (ASCII) stands in `bytes` at `at`. */
function has(bytes: Uint8Array, at: number, text: string): boolean {
  return (
    bytes.length >= at + text.length &&
    [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))
  )
}

/**
 * The brands of an ISO media file (its `ftyp` box) that are not a video:
 * still images in the same container, and sound alone. QuickTime's is a
 * video of its own type; every other brand is an MP4.
 */
const FTYP_BRANDS: Record<string, string> = {
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heix: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  "M4A ": "audio/mp4",
  "qt  ": "video/quicktime",
}

/** The media type a binary file's first bytes name, or null when unknown. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const found = SIGNATURES.find(
    ({ bytes: signature }) =>
      bytes.length >= signature.length &&
      signature.every((byte, index) => bytes[index] === byte),
  )

  if (found) {
    return found.type
  }

  // RIFF, its size, then the form: WebP's is "WEBP".
  if (has(bytes, 0, "RIFF") && has(bytes, 8, "WEBP")) {
    return "image/webp"
  }

  // An ISO media file (MP4, QuickTime, HEIF): its size, "ftyp", its brand.
  if (has(bytes, 4, "ftyp") && bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12))

    return FTYP_BRANDS[brand] ?? "video/mp4"
  }

  // Matroska's EBML header, whose doc type says when it is a WebM.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    const header = String.fromCharCode(...bytes.subarray(4, 64))

    return header.includes("webm") ? "video/webm" : "video/x-matroska"
  }

  return null
}

/**
 * What a file is when nothing names its media type (a browser download, an
 * upload by link): its name's extension says, then its first bytes, then
 * whether it reads as text. A text type gets the charset its bytes are in,
 * when they are UTF-8.
 */
const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  ics: "text/calendar",
  vcf: "text/vcard",
  eml: "message/rfc822",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avif: "image/avif",
  heic: "image/heic",
}

export function fileMediaType(name: string, bytes: Uint8Array): string {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase()
  const type =
    (extension ? BY_EXTENSION[extension] : undefined) ??
    sniffMediaType(bytes) ??
    (isTextBytes(bytes) ? "text/plain" : "application/octet-stream")

  return isTextType(type) && isTextBytes(bytes)
    ? `${type}; charset=utf-8`
    : type
}
