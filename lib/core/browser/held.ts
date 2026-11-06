import { createHmac, randomBytes, randomInt } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Page } from "patchright-core"

import {
  ACTION_TIMEOUT_MS,
  MAX_MASKED_FRAMES,
  MIN_NORMALISED_MASK_CHARS,
} from "./limits"
import { bounded } from "./queue"

/**
 * What a page holds of the secrets PCP typed into it (browser/call.ts):
 * each secret's name and keyed hashes of what its field held once typed,
 * never the value. The page holds a secret while one of its fields (in any
 * frame) has that value, as typed or as the page reformatted it (the same
 * once white space and separators are taken out and it is upper-cased, as
 * a site writes an IBAN "NL91 ABNA 0417 …"): the field it was typed into,
 * or one it was copied to. It lets go when no field has it any more: the
 * field changed, or the tab opened a new document (a navigation, a reload)
 * that does not have it. While it holds one, every answer about the page
 * shows those fields as [secret: name] and the value as that wherever it
 * appears (snapshot.ts, call.ts), and no screenshot is taken.
 *
 * Kept by page, in memory only: a reopened tab has a new page and holds
 * nothing, and nothing of it is saved anywhere.
 *
 * Besides what the page holds now, it remembers every secret PCP typed into
 * it for as long as the page lives (typed), by the same keyed hashes: a page
 * that moved on may still repeat the value (a summary page, its console, a
 * response, an address), and every answer about the token's tabs, the logs
 * and evaluate's result mask any word of theirs whose hash is one of these,
 * and any run of their text that is the value once read the normalised way
 * (maskTyped). That run is found by sliding a window of the value's length
 * over the text: a keyed rolling fingerprint picks the few places worth
 * hashing, so a long answer costs arithmetic per character, not a hash.
 */

type Held = {
  name: string
  /** The value as it is. */
  digest: string
  length: number
  /** The value with white space and separators out, upper case. */
  normal: { digest: string; length: number; print: number } | null
}

const HELD = new WeakMap<Page, Held[]>()
const TYPED = new WeakMap<Page, Held[]>()
/** The hashes' key, this process's own: they mean nothing anywhere else. */
const KEY = randomBytes(32)
/**
 * The rolling fingerprint's modulus (a prime under 2^25, so that every
 * product below stays an exact integer) and its base, this process's own.
 */
const MODULUS = 33_554_393
const BASE = randomInt(65_537, MODULUS - 1)

function digestOf(value: string): string {
  return createHmac("sha256", KEY).update(value).digest("base64")
}

/**
 * The characters a page puts in or takes out when it writes a value its
 * own way: white space (and the invisible spaces), dashes, dots, slashes.
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

function heldOf(name: string, value: string): Held {
  const normal = normalised(value).chars

  return {
    name,
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

/** Notes that a field of the page holds the secret, with the value it has. */
export function holdSecret(page: Page, name: string, value: string): void {
  if (!value) {
    return
  }

  const held = heldOf(name, value)
  const list = (HELD.get(page) ?? []).filter(
    (other) => other.digest !== held.digest,
  )
  list.push(held)
  HELD.set(page, list)
  const typed = (TYPED.get(page) ?? []).filter(
    (other) => other.digest !== held.digest,
  )
  typed.push(held)
  TYPED.set(page, typed)
}

/** Whether PCP has typed a secret into the page since it opened. */
export function typedInto(page: Page): boolean {
  return (TYPED.get(page)?.length ?? 0) > 0
}

/** The longest word maskTyped hashes: more than any secret PCP types. */
const MAX_WORD_CHARS = 4_096

/**
 * The text with every word that is a secret PCP typed into the page shown
 * as [secret: name]: words split at white space, quotes, brackets and the
 * marks that join a form's or an address's fields, each also read as an
 * address's encoding would have it; then every run of it that is one once
 * white space and separators are out and it is upper-cased (a value the
 * page wrote its own way, within a longer word or across several).
 */
export function maskTyped(page: Page, text: string): string {
  return maskTypedIn([page], text)
}

/** maskTyped with what PCP typed into any of the pages. */
export function maskTypedIn(pages: Iterable<Page>, text: string): string {
  const masker = typedMasker(pages)
  return masker ? masker(text) : text
}

/**
 * Every string of an answer (its texts, a resource's text, the structured
 * content's strings and keys) masked as maskTyped does, with what PCP
 * typed into any of the pages: the token's tabs, for as long as each
 * lives, whichever document it shows now. Images are left as they are.
 */
export function maskTypedResult(
  pages: Iterable<Page>,
  result: CallToolResult,
): CallToolResult {
  const masker = typedMasker(pages)

  if (!masker) {
    return result
  }

  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") return masker(input)
    if (typeof input !== "object" || input === null || depth > 100) {
      return input
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1))

    const out: Record<string, unknown> = {}

    for (const [key, item] of Object.entries(input)) {
      if (key !== "__proto__") out[masker(key)] = walk(item, depth + 1)
    }

    return out
  }

  return {
    ...result,
    content: result.content.map((part) => {
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
          structuredContent: walk(result.structuredContent, 0) as Record<
            string,
            unknown
          >,
        }
      : {}),
  }
}

/** What masks the text, from what PCP typed into the pages; null for nothing. */
function typedMasker(pages: Iterable<Page>): ((text: string) => string) | null {
  const typed: Held[] = []

  for (const page of pages) typed.push(...(TYPED.get(page) ?? []))

  if (typed.length === 0) {
    return null
  }

  const names = new Map(typed.map((held) => [held.digest, held.name]))
  const lengths = new Set(typed.map((held) => held.length))
  const mask = (word: string) => {
    if (word.length > MAX_WORD_CHARS) {
      return word
    }

    const name =
      (lengths.has(word.length) ? names.get(digestOf(word)) : undefined) ??
      (/[%+]/.test(word) ? names.get(digestOf(decoded(word))) : undefined)
    return name === undefined ? word : `[secret: ${name}]`
  }

  // By the normalised value's length: the fingerprints worth hashing, and
  // the hashes that name a secret.
  const windows = new Map<
    number,
    { prints: Set<number>; names: Map<string, string>; lead: number }
  >()

  for (const held of typed) {
    if (!held.normal || held.normal.length < MIN_NORMALISED_MASK_CHARS) {
      continue
    }

    const { length, print, digest } = held.normal
    let window = windows.get(length)

    if (!window) {
      let lead = 1
      for (let step = 1; step < length; step += 1) {
        lead = (lead * BASE) % MODULUS
      }
      window = { prints: new Set(), names: new Map(), lead }
      windows.set(length, window)
    }

    window.prints.add(print)
    window.names.set(digest, held.name)
  }

  return (text) => {
    if (text.length === 0) {
      return text
    }

    // Whole words first (a secret may hold any mark but white space and
    // quotes), then the parts of a form's fields or an address's query.
    const worded = text
      .replace(/[^\s"'`<>]+/g, mask)
      .replace(/[^\s"'`&=,;:{}[\]()<>?#|]+/g, mask)

    return windows.size > 0 ? maskRuns(worded, windows) : worded
  }
}

/**
 * The text with every run that reads as a typed value once normalised shown
 * as [secret: name]: each window of the value's length whose fingerprint
 * is one of the value's is hashed, and a hash that names a secret masks the
 * text that window came from (runs that touch become one).
 */
function maskRuns(
  text: string,
  windows: Map<
    number,
    { prints: Set<number>; names: Map<string, string>; lead: number }
  >,
): string {
  const { chars, start, end } = normalised(text)
  const found: Array<{ from: number; to: number; name: string }> = []

  for (const [length, { prints, names, lead }] of windows) {
    if (chars.length < length) continue

    let print = fingerprint(chars, 0, length)

    for (let at = 0; ; at += 1) {
      if (prints.has(print)) {
        const name = names.get(digestOf(chars.slice(at, at + length)))

        if (name !== undefined) {
          found.push({ from: start[at]!, to: end[at + length - 1]!, name })
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
    const { from, name } = found[index]!
    let to = found[index]!.to

    for (index += 1; index < found.length && found[index]!.from <= to;) {
      to = Math.max(to, found[index]!.to)
      index += 1
    }

    parts.push(text.slice(at, from), `[secret: ${name}]`)
    at = to
  }

  parts.push(text.slice(at))
  return parts.join("")
}

function decoded(word: string): string {
  try {
    return decodeURIComponent(word.replace(/\+/g, " "))
  } catch {
    return word
  }
}

/** Every field's value in the page's frames; null when one could not be read. */
async function fieldValues(page: Page): Promise<string[] | null> {
  const values: string[] = []

  for (const frame of page.frames().slice(0, MAX_MASKED_FRAMES)) {
    const found = await bounded(
      frame
        .locator("input, textarea")
        .evaluateAll((fields) =>
          fields.map(
            (field) => (field as HTMLInputElement | HTMLTextAreaElement).value,
          ),
        ),
      ACTION_TIMEOUT_MS,
      "field values",
    ).catch(() => null)

    if (found === null) {
      // A frame gone since it was listed holds nothing; a page that does
      // not answer may still hold it.
      if (!frame.isDetached()) {
        return null
      }

      continue
    }

    values.push(...found)
  }

  return values
}

/**
 * The secrets the page still holds, and their values as its fields have
 * them now (for the answers to show as [secret: name]): a field holds one
 * when its value is the one typed, as it is or once normalised (the page
 * reformatted it). One no field has any more is let go; while the fields
 * cannot be read (a busy page), every one is kept, without values.
 */
export async function heldValues(page: Page): Promise<{
  names: string[]
  values: Array<{ name: string; value: string }>
}> {
  const list = HELD.get(page)

  if (!list || list.length === 0) {
    return { names: [], values: [] }
  }

  const fields = await fieldValues(page)

  if (fields === null) {
    return { names: list.map((held) => held.name), values: [] }
  }

  const byDigest = new Map<string, string>()
  const byNormal = new Map<string, string>()

  for (const value of fields) {
    if (value) {
      byDigest.set(digestOf(value), value)
      const normal = normalised(value).chars
      if (normal) byNormal.set(digestOf(normal), value)
    }
  }

  const valueOf = (held: Held) =>
    byDigest.get(held.digest) ??
    (held.normal ? byNormal.get(held.normal.digest) : undefined)
  const kept = list.filter((held) => valueOf(held) !== undefined)

  if (kept.length > 0) {
    HELD.set(page, kept)
  } else {
    HELD.delete(page)
  }

  return {
    names: [...new Set(kept.map((held) => held.name))],
    values: kept.map((held) => ({ name: held.name, value: valueOf(held)! })),
  }
}

/** The name of a secret the page still holds; null for none. */
export async function heldSecret(page: Page): Promise<string | null> {
  return (await heldValues(page)).names[0] ?? null
}
