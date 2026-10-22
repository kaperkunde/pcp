import { createHmac, randomBytes } from "node:crypto"

import type { Page } from "patchright-core"

import { ACTION_TIMEOUT_MS, MAX_MASKED_FRAMES } from "./limits"
import { bounded } from "./queue"

/**
 * What a page holds of the secrets PCP typed into it (browser/call.ts):
 * each secret's name and a keyed hash of what its field held once typed,
 * never the value. The page holds a secret while one of its fields (in any
 * frame) has that value: the field it was typed into, or one it was copied
 * to. It lets go when no field has it any more: the field changed, or the
 * tab opened a new document (a navigation, a reload) that does not have it.
 * While it holds one, every answer about
 * the page shows those fields as [secret: name] and the value as that
 * wherever it appears (snapshot.ts, call.ts), and no screenshot is taken.
 *
 * Kept by page, in memory only: a reopened tab has a new page and holds
 * nothing, and nothing of it is saved anywhere.
 */

type Held = { name: string; digest: string }

const HELD = new WeakMap<Page, Held[]>()
/** The hashes' key, this process's own: they mean nothing anywhere else. */
const KEY = randomBytes(32)

function digestOf(value: string): string {
  return createHmac("sha256", KEY).update(value).digest("base64")
}

/** Notes that a field of the page holds the secret, with the value it has. */
export function holdSecret(page: Page, name: string, value: string): void {
  if (!value) {
    return
  }

  const digest = digestOf(value)
  const list = (HELD.get(page) ?? []).filter((held) => held.digest !== digest)
  list.push({ name, digest })
  HELD.set(page, list)
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
 * them now (for the answers to show as [secret: name]). One no field has
 * any more is let go; while the fields cannot be read (a busy page), every
 * one is kept, without values.
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

  for (const value of fields) {
    if (value) {
      byDigest.set(digestOf(value), value)
    }
  }

  const kept = list.filter((held) => byDigest.has(held.digest))

  if (kept.length > 0) {
    HELD.set(page, kept)
  } else {
    HELD.delete(page)
  }

  return {
    names: kept.map((held) => held.name),
    values: kept.map((held) => ({
      name: held.name,
      value: byDigest.get(held.digest)!,
    })),
  }
}

/** The name of a secret the page still holds; null for none. */
export async function heldSecret(page: Page): Promise<string | null> {
  return (await heldValues(page)).names[0] ?? null
}
