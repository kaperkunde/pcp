/**
 * The owner's Files pages (app/(dashboard)/files/): which files they
 * preview and how, and the byte ranges the store's file route
 * (app/api/storage/[id]/download) serves. Pure: nothing here reads a store.
 *
 * A preview is offered by the file's name and served by its bytes. An
 * image, a PDF, a sound or a video goes as itself only when its first bytes
 * say it is one of the kinds a browser shows with nothing of the file
 * running (no SVG: it is a document that can carry script); text goes as
 * plain text, HTML and SVG among it; anything else only as a download.
 */

import { sniffMediaType } from "../media-types"

/** How the Files pages show a file before it is downloaded. */
export type StorePreview = "image" | "pdf" | "text" | "audio" | "video"

/** The first bytes the route reads to tell what a file is. */
export const SNIFF_BYTES = 64

/** The start of a text file a preview shows, before "Show all". */
export const TEXT_PREVIEW_BYTES = 64 * 1024

/** The most of a text file "Show all" reads; past it, a download. */
export const TEXT_SHOW_ALL_BYTES = 2 * 1024 * 1024

/**
 * The most the page uploads at once: the files travel in a Server Action,
 * whose body Next bounds (next.config.ts `bodySizeLimit`).
 */
export const PAGE_UPLOAD_BYTES = 64 * 1024 * 1024

const IMAGE = "image"
const PDF = "pdf"
const TEXT = "text"
const AUDIO = "audio"
const VIDEO = "video"

const BY_EXTENSION: Record<string, StorePreview> = {
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  avif: IMAGE,
  pdf: PDF,
  txt: TEXT,
  text: TEXT,
  md: TEXT,
  markdown: TEXT,
  json: TEXT,
  jsonl: TEXT,
  ndjson: TEXT,
  csv: TEXT,
  tsv: TEXT,
  log: TEXT,
  yaml: TEXT,
  yml: TEXT,
  toml: TEXT,
  ini: TEXT,
  conf: TEXT,
  cfg: TEXT,
  xml: TEXT,
  // Documents that can carry script: shown as their text, never rendered.
  svg: TEXT,
  html: TEXT,
  htm: TEXT,
  css: TEXT,
  js: TEXT,
  mjs: TEXT,
  ts: TEXT,
  tsx: TEXT,
  jsx: TEXT,
  py: TEXT,
  rb: TEXT,
  go: TEXT,
  rs: TEXT,
  java: TEXT,
  c: TEXT,
  h: TEXT,
  sh: TEXT,
  sql: TEXT,
  ics: TEXT,
  vcf: TEXT,
  eml: TEXT,
  srt: TEXT,
  vtt: TEXT,
  mp3: AUDIO,
  m4a: AUDIO,
  aac: AUDIO,
  ogg: AUDIO,
  oga: AUDIO,
  opus: AUDIO,
  wav: AUDIO,
  flac: AUDIO,
  mp4: VIDEO,
  m4v: VIDEO,
  webm: VIDEO,
  mov: VIDEO,
}

/** How a file is previewed, by its name's extension; null when it is not. */
export function previewOfName(name: string): StorePreview | null {
  const extension = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase()

  return (extension && BY_EXTENSION[extension]) || null
}

/** Whether `text` (ASCII) stands in `bytes` at `at`. */
function has(bytes: Uint8Array, at: number, text: string): boolean {
  return (
    bytes.length >= at + text.length &&
    [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))
  )
}

/**
 * What a sound file's first bytes say it is, for the kinds media-types.ts
 * does not name (so as not to change what it says elsewhere).
 */
function sniffAudio(bytes: Uint8Array): string | null {
  if (has(bytes, 0, "ID3")) return "audio/mpeg"
  // An MPEG audio frame's sync: eleven bits set, MPEG-1 or 2, layer III.
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    [0xfb, 0xfa, 0xf3, 0xf2].includes(bytes[1]!)
  ) {
    return "audio/mpeg"
  }
  if (has(bytes, 0, "OggS")) return "audio/ogg"
  if (has(bytes, 0, "fLaC")) return "audio/flac"
  if (has(bytes, 0, "RIFF") && has(bytes, 8, "WAVE")) return "audio/wav"
  return null
}

/** The media type a stored file's first bytes name, or null. */
export function sniffStoreFile(head: Uint8Array): string | null {
  return sniffMediaType(head) ?? sniffAudio(head)
}

/** What each preview goes out as, by the type its bytes name. */
const SERVED_AS: Record<Exclude<StorePreview, "text">, ReadonlySet<string>> = {
  image: new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
  ]),
  pdf: new Set(["application/pdf"]),
  // An <audio> element plays the sound of an MP4 or WebM file too.
  audio: new Set([
    "audio/mpeg",
    "audio/ogg",
    "audio/flac",
    "audio/wav",
    "audio/mp4",
    "video/mp4",
    "video/webm",
  ]),
  video: new Set(["video/mp4", "video/webm", "video/quicktime"]),
}

/** A sandboxed document runs nothing, even where its type is wrong. */
export const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox"

/** How a preview goes out: its type and the policy it carries. */
export type ServedPreview = { contentType: string; csp: string }

/**
 * How a file goes to the owner's page to be shown, or null when it goes
 * only as a download: text as plain text (whatever it is, so nothing in
 * it runs); anything else as itself only when its first bytes (`head`)
 * say it is a kind its preview shows.
 */
export function servedPreview(
  preview: StorePreview | null,
  head: Uint8Array,
): ServedPreview | null {
  if (preview === null) {
    return null
  }

  if (preview === "text") {
    return { contentType: "text/plain; charset=utf-8", csp: LOCKED_CSP }
  }

  const sniffed = sniffStoreFile(head)

  if (!sniffed || !SERVED_AS[preview].has(sniffed)) {
    return null
  }

  return {
    contentType: sniffed,
    // The browser's PDF viewer does not open in a sandboxed document: a
    // PDF whose first bytes say it is one, sent as one with nosniff, runs
    // nothing of PCP's page. A sound or a video opened in a tab of its own
    // is a media document that loads the file again, from PCP itself.
    csp:
      preview === "pdf"
        ? "frame-ancestors 'none'"
        : preview === "image"
          ? LOCKED_CSP
          : "default-src 'none'; media-src 'self'; frame-ancestors 'none'; sandbox",
  }
}

/** A part of a file, as a route serves it. */
export type ByteRange = { offset: number; length: number }

/** The largest offset a Range header may name: 2^53 has 16 digits. */
const MAX_DIGITS = 15

/**
 * The part of a file of `size` bytes a Range header asks for (RFC 9110
 * §14): one range, `bytes=first-last`, `bytes=first-` or `bytes=-suffix`.
 * Null serves the whole file: no header, one PCP does not take (another
 * unit, several ranges) or one that is not well formed. "unsatisfiable"
 * is a range that starts past the end (416).
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) {
    return null
  }

  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)

  if (!match) {
    return null
  }

  const [, first = "", last = ""] = match

  if (
    (first === "" && last === "") ||
    first.length > MAX_DIGITS ||
    last.length > MAX_DIGITS
  ) {
    return null
  }

  if (first === "") {
    const suffix = Number(last)

    if (suffix === 0 || size === 0) {
      return "unsatisfiable"
    }

    const offset = Math.max(0, size - suffix)
    return { offset, length: size - offset }
  }

  const offset = Number(first)

  if (last !== "" && Number(last) < offset) {
    return null
  }

  if (offset >= size) {
    return "unsatisfiable"
  }

  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1)
  return { offset, length: end - offset + 1 }
}

/** The Content-Range of a part served (206), or of none (416). */
export function contentRange(range: ByteRange | null, size: number): string {
  return range
    ? `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`
    : `bytes */${size}`
}

const ONE_DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const UNITS = ["KB", "MB", "GB", "TB"]

/** A size as the owner reads it: "812 B", "12.3 MB", "1.5 GB". */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} B`
  }

  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${ONE_DECIMAL.format(value)} ${UNITS[unit]}`
}
