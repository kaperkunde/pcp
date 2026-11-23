import { createHmac, randomBytes, randomInt } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/server"

/**
 * Finding a value PCP must not show again in a text, without holding the
 * value: what the browser typed (browser/held.ts) and what keep made
 * pass-only (kept-masks.ts). A value is remembered only as keyed hashes
 * of it, as it is and as it reads normalised (white space and separators
 * out, upper case: an IBAN written "NL91 ABNA 0417 …"), and a keyed
 * rolling fingerprint of the normalised form.
 *
 * A text is masked word by word (each word hashed when its length is a
 * value's), then run by run: a window of the normalised value's length
 * slides over the normalised text, and only where its fingerprint is one
 * of a value's is that window hashed, so a long text costs arithmetic per
 * character, not a hash. Everything is this process's own (the key, the
 * base), in memory only: the hashes mean nothing anywhere else.
 */

/** The hashes' key, this process's own. */
const KEY = randomBytes(32)
/**
 * The rolling fingerprint's modulus (a prime under 2^25, so that every
 * product below stays an exact integer) and its base, this process's own.
 */
const MODULUS = 33_554_393
const BASE = randomInt(65_537, MODULUS - 1)
/** The longest word hashed whole: more than any value masked by word. */
const MAX_WORD_CHARS = 4_096

/** A value as it is remembered: its hashes, never itself. */
export type MaskedValue = {
  /** What stands in for it: a secret's name, a kept result's id. */
  label: string
  /** The value as it is. */
  digest: string
  length: number
  /** The value with white space and separators out, upper case. */
  normal: { digest: string; length: number; print: number } | null
}

export function digestOf(value: string): string {
  return createHmac("sha256", KEY).update(value).digest("base64")
}

/**
 * The characters a page or an API puts in or takes out when it writes a
 * value its own way: white space (and the invisible spaces), dashes, dots,
 * slashes.
 */
function isSeparator(code: number): boolean {
  return (
    code <= 0x20 ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x2f ||
    code === 0x5c ||
    code === 0x7f ||
    code === 0xa0 ||
    code === 0xad ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200d) ||
    (code >= 0x2010 && code <= 0x2015) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x2060 ||
    code === 0x2212 ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

/**
 * The text with its separators out and upper case, and for each of its
 * characters where it came from in the text: from `start[i]` up to
 * `end[i]`.
 */
export function normalised(text: string): {
  chars: string
  start: Int32Array
  end: Int32Array
} {
  // Upper case can make one character two (ß is SS): room for that, grown
  // when a text needs more.
  let codes = new Uint16Array(text.length + 16)
  let start = new Int32Array(codes.length)
  let end = new Int32Array(codes.length)
  let length = 0
  const put = (code: number, from: number, to: number) => {
    if (length === codes.length) {
      const grown = codes.length * 2
      codes = grownTo(codes, new Uint16Array(grown))
      start = grownTo(start, new Int32Array(grown))
      end = grownTo(end, new Int32Array(grown))
    }

    codes[length] = code
    start[length] = from
    end[length] = to
    length += 1
  }

  for (let at = 0; at < text.length;) {
    const code = text.charCodeAt(at)

    if (code < 0x80) {
      if (!isSeparator(code)) {
        put(code >= 0x61 && code <= 0x7a ? code - 0x20 : code, at, at + 1)
      }

      at += 1
      continue
    }

    const width = text.codePointAt(at)! > 0xffff ? 2 : 1

    if (width === 1 && isSeparator(code)) {
      at += 1
      continue
    }

    const upper = text.slice(at, at + width).toUpperCase()

    for (let unit = 0; unit < upper.length; unit += 1) {
      put(upper.charCodeAt(unit), at, at + width)
    }

    at += width
  }

  const parts: string[] = []

  for (let from = 0; from < length; from += 8_192) {
    parts.push(
      String.fromCharCode(
        ...codes.subarray(from, Math.min(length, from + 8_192)),
      ),
    )
  }

  return {
    chars: parts.join(""),
    start: start.subarray(0, length),
    end: end.subarray(0, length),
  }
}

function grownTo<T extends Uint16Array | Int32Array>(from: T, to: T): T {
  to.set(from)
  return to
}

/** The rolling fingerprint of chars[from, from + length). */
function fingerprint(chars: string, from: number, length: number): number {
  let print = 0

  for (let at = from; at < from + length; at += 1) {
    print = (print * BASE + chars.charCodeAt(at)) % MODULUS
  }

  return print
}

/** A value's hashes and fingerprint, to look for it without holding it. */
export function maskedValue(label: string, value: string): MaskedValue {
  const normal = normalised(value).chars

  return {
    label,
    digest: digestOf(value),
    length: value.length,
    normal:
      normal.length > 0
        ? {
            digest: digestOf(normal),
            length: normal.length,
            print: fingerprint(normal, 0, normal.length),
          }
        : null,
  }
}

type Windows = Map<
  number,
  { prints: Set<number>; labels: Map<string, string>; lead: number }
>

/**
 * What masks a text with the values, each shown as `render(label)`: every
 * word that is one (split at white space, quotes, brackets and the marks
 * that join a form's or an address's fields, each also read as an
 * address's encoding would have it), then every run that is one once
 * normalised, for values at least `minNormalChars` long read that way
 * (a shorter one is masked as a whole word only: it would mask ordinary
 * text). Null when there is nothing to look for.
 */
export function valueMasker(
  values: MaskedValue[],
  {
    render,
    minNormalChars,
  }: { render: (label: string) => string; minNormalChars: number },
): ((text: string) => string) | null {
  if (values.length === 0) {
    return null
  }

  const labels = new Map(values.map((value) => [value.digest, value.label]))
  const lengths = new Set(values.map((value) => value.length))
  const mask = (word: string) => {
    if (word.length > MAX_WORD_CHARS) {
      return word
    }

    const label =
      (lengths.has(word.length) ? labels.get(digestOf(word)) : undefined) ??
      (/[%+]/.test(word) ? labels.get(digestOf(decoded(word))) : undefined)
    return label === undefined ? word : render(label)
  }

  // By the normalised value's length: the fingerprints worth hashing, and
  // the hashes that name a value.
  const windows: Windows = new Map()

  for (const value of values) {
    if (!value.normal || value.normal.length < minNormalChars) {
      continue
    }

    const { length, print, digest } = value.normal
    let window = windows.get(length)

    if (!window) {
      let lead = 1
      for (let step = 1; step < length; step += 1) {
        lead = (lead * BASE) % MODULUS
      }
      window = { prints: new Set(), labels: new Map(), lead }
      windows.set(length, window)
    }

    window.prints.add(print)
    window.labels.set(digest, value.label)
  }

  return (text) => {
    if (text.length === 0) {
      return text
    }

    // Whole words first (a value may hold any mark but white space and
    // quotes), then the parts of a form's fields or an address's query.
    const worded = text
      .replace(/[^\s"'`<>]+/g, mask)
      .replace(/[^\s"'`&=,;:{}[\]()<>?#|]+/g, mask)

    return windows.size > 0 ? maskRuns(worded, windows, render) : worded
  }
}

/**
 * The text with every run that reads as a value once normalised shown as
 * `render(label)`: each window of the value's length whose fingerprint is
 * one of the value's is hashed, and a hash that names a value masks the
 * text that window came from (runs that touch become one).
 */
function maskRuns(
  text: string,
  windows: Windows,
  render: (label: string) => string,
): string {
  const { chars, start, end } = normalised(text)
  const found: Array<{ from: number; to: number; label: string }> = []

  for (const [length, { prints, labels, lead }] of windows) {
    if (chars.length < length) continue

    let print = fingerprint(chars, 0, length)

    for (let at = 0; ; at += 1) {
      if (prints.has(print)) {
        const label = labels.get(digestOf(chars.slice(at, at + length)))

        if (label !== undefined) {
          found.push({
            ...outsideEscapes(text, start[at]!, end[at + length - 1]!),
            label,
          })
        }
      }

      if (at + length >= chars.length) break

      const out = (chars.charCodeAt(at) * lead) % MODULUS
      print =
        (((print - out + MODULUS) % MODULUS) * BASE +
          chars.charCodeAt(at + length)) %
        MODULUS
    }
  }

  if (found.length === 0) {
    return text
  }

  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const parts: string[] = []
  let at = 0

  for (let index = 0; index < found.length;) {
    const { from, label } = found[index]!
    let to = found[index]!.to

    for (index += 1; index < found.length && found[index]!.from <= to;) {
      to = Math.max(to, found[index]!.to)
      index += 1
    }

    parts.push(text.slice(at, from), render(label))
    at = to
  }

  parts.push(text.slice(at))
  return parts.join("")
}

/** Whether text[at] is a backslash that starts an escape (an odd run). */
function startsEscape(text: string, at: number): boolean {
  if (at < 0 || text.charCodeAt(at) !== 0x5c) {
    return false
  }

  let run = 1

  while (at - run >= 0 && text.charCodeAt(at - run) === 0x5c) {
    run += 1
  }

  return run % 2 === 1
}

/**
 * A run widened so it does not cut an escape in two (a backslash is a
 * separator, so a run can start right after one, or inside a JSON
 * `\uXXXX`): what stands in its place leaves the text valid JSON.
 */
function outsideEscapes(
  text: string,
  from: number,
  to: number,
): { from: number; to: number } {
  for (let at = from - 1; at >= Math.max(0, from - 5); at -= 1) {
    if (startsEscape(text, at)) {
      const unicode = text.charCodeAt(at + 1) === 0x75
      if (at === from - 1 || (unicode && from <= at + 5)) from = at
      break
    }
  }

  for (let at = to - 1; at >= Math.max(from, to - 5); at -= 1) {
    if (startsEscape(text, at)) {
      const end = text.charCodeAt(at + 1) === 0x75 ? at + 6 : at + 2
      to = Math.min(text.length, Math.max(to, end))
      break
    }
  }

  return { from, to }
}

function decoded(word: string): string {
  try {
    return decodeURIComponent(word.replace(/\+/g, " "))
  } catch {
    return word
  }
}

/** Every string of a JSON value (keys too) through `masker`. */
export function maskJson(
  masker: (text: string) => string,
  input: unknown,
  depth = 0,
): unknown {
  if (typeof input === "string") return masker(input)
  if (typeof input !== "object" || input === null || depth > 100) {
    return input
  }
  if (Array.isArray(input)) {
    return input.map((item) => maskJson(masker, item, depth + 1))
  }

  const out: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(input)) {
    if (key !== "__proto__")
      out[masker(key)] = maskJson(masker, item, depth + 1)
  }

  return out
}

/**
 * Every string of an answer (its texts, a resource's text, the structured
 * content's strings and keys) through `masker`. Images are left as they
 * are.
 */
export function maskResultWith(
  masker: (text: string) => string,
  result: CallToolResult,
): CallToolResult {
  return {
    ...result,
    content: (result.content ?? []).map((part) => {
      if (part.type === "text") {
        return { ...part, text: masker(part.text) }
      }

      if (part.type === "resource" && "text" in part.resource) {
        return {
          ...part,
          resource: { ...part.resource, text: masker(part.resource.text) },
        }
      }

      return part
    }),
    ...(result.structuredContent !== undefined
      ? {
          structuredContent: maskJson(
            masker,
            result.structuredContent,
          ) as Record<string, unknown>,
        }
      : {}),
  }
}
