import type { Locator, Page } from "playwright-core"

import { ACTION_TIMEOUT_MS, MAX_FIND_MATCHES } from "./limits"

/**
 * The page as an assistant reads it: Playwright's accessibility snapshot
 * made for AI use, every element it can act on marked with a ref
 * ("[ref=e12]"), and the locator a ref stands for. The only file that
 * names Playwright's snapshot API, so a change to it is a change here.
 * A ref is good until the next snapshot of the page.
 */

/** e12, or f1e12 for an element after the page was replaced or in a frame. */
export const REF_PATTERN = /^(f\d{1,4})?e\d{1,7}$/

export function snapshotTree(page: Page): Promise<string> {
  return page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS })
}

export function byRef(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${ref}`)
}

/** The element a ref stands for, or null when the page no longer has it. */
export async function resolveRef(
  page: Page,
  ref: string,
): Promise<Locator | null> {
  const locator = byRef(page, ref)
  const found = await locator.count().catch(() => 0)
  return found > 0 ? locator : null
}

/** The lines of a snapshot that mention the text, case aside. */
export function findInSnapshot(tree: string, text: string): string[] {
  const needle = text.toLowerCase()

  return tree
    .split("\n")
    .filter((line) => line.toLowerCase().includes(needle))
    .map((line) => line.trim())
    .slice(0, MAX_FIND_MATCHES)
}
