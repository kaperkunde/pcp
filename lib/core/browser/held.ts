import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Page } from "patchright-core"

import {
  digestOf,
  maskedValue,
  maskResultWith,
  normalised,
  valueMasker,
  type MaskedValue,
} from "../value-masks"
import {
  ACTION_TIMEOUT_MS,
  MAX_MASKED_FRAMES,
  MIN_NORMALISED_MASK_CHARS,
} from "./limits"
import { bounded } from "./queue"

export { normalised }

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

type Held = MaskedValue & { name: string }

const HELD = new WeakMap<Page, Held[]>()
const TYPED = new WeakMap<Page, Held[]>()

function heldOf(name: string, value: string): Held {
  return { ...maskedValue(name, value), name }
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
  return masker ? maskResultWith(masker, result) : result
}

/** What masks the text, from what PCP typed into the pages; null for nothing. */
function typedMasker(pages: Iterable<Page>): ((text: string) => string) | null {
  const typed: Held[] = []

  for (const page of pages) typed.push(...(TYPED.get(page) ?? []))

  return valueMasker(typed, {
    render: (name) => `[secret: ${name}]`,
    minNormalChars: MIN_NORMALISED_MASK_CHARS,
  })
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

/** What typedShown answers when a frame of the page could not be read. */
export const UNREAD = Symbol("unread")

/**
 * The name of a secret PCP typed into any of `pages` that `page` shows,
 * in a frame's text or a field's value, as maskTyped finds it (as typed
 * or written the page's own way); null for none, UNREAD when a frame that
 * is still there could not be read. A picture or a PDF of the page would
 * carry what masking an answer's text cannot reach.
 */
export async function typedShown(
  page: Page,
  pages: Iterable<Page>,
): Promise<string | null | typeof UNREAD> {
  const masker = typedMasker(pages)

  if (!masker) {
    return null
  }

  for (const frame of page.frames().slice(0, MAX_MASKED_FRAMES)) {
    const texts = await bounded(
      frame
        .locator("html")
        .evaluateAll((roots) =>
          roots.flatMap((root) => [
            (root as HTMLElement).innerText ?? root.textContent ?? "",
            ...Array.from(
              root.querySelectorAll("input, textarea"),
              (field) =>
                (field as HTMLInputElement | HTMLTextAreaElement).value,
            ),
          ]),
        ),
      ACTION_TIMEOUT_MS,
      "page text",
    ).catch(() => null)

    if (texts === null) {
      if (!frame.isDetached()) return UNREAD
      continue
    }

    for (const text of texts) {
      const masked = masker(text)

      if (masked !== text) {
        const found = /\[secret: ([^\]]+)\]/.exec(masked)
        if (found && !text.includes(found[0])) return found[1]!
      }
    }
  }

  return null
}

/** The name of a secret the page still holds; null for none. */
export async function heldSecret(page: Page): Promise<string | null> {
  return (await heldValues(page)).names[0] ?? null
}
