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

/** The media type a binary file's first bytes name, or null when unknown. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const found = SIGNATURES.find(
    ({ bytes: signature }) =>
      bytes.length >= signature.length &&
      signature.every((byte, index) => bytes[index] === byte),
  )

  return found?.type ?? null
}
