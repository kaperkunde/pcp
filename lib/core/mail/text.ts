/**
 * Which attachments PCP passes on as text, and how their bytes become one.
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
