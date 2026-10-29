import { htmlToMarkdown } from "../fetch/html"

/**
 * read_page's text: the live page's HTML as Markdown, as web_fetch makes
 * it (fetch/html.ts), less what the page does not show. That is what its
 * HTML says is hidden (the hidden attribute, aria-hidden="true", an inline
 * display: none or visibility: hidden, a dialog that is not open), and
 * blocks of code that are data, not words: a <code> or <pre> whose text
 * is JSON. A site's app (LinkedIn's messages, for one) carries its state
 * that way, hidden, and it was nearly all of what the page's HTML held.
 * Hidden by a stylesheet's rule cannot be told from the HTML, and stays.
 * web_fetch is unchanged: it reads what a site sends, not a page shown.
 */

/** A code block this long whose text is JSON is data, not something shown. */
export const MIN_JSON_BLOCK_CHARS = 200

export type LeftOut = {
  /** Elements the page's HTML marks as hidden. */
  hidden: number
  /** Code blocks that are JSON, and their characters. */
  json: number
  jsonChars: number
}

const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i

function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) {
    return true
  }

  if (element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") {
    return true
  }

  if (element.localName === "dialog" && !element.hasAttribute("open")) {
    return true
  }

  return HIDDEN_STYLE.test(element.getAttribute("style") ?? "")
}

/** Whether a text is a JSON object or list (not "[1]" or a quoted word). */
export function isJsonData(text: string): boolean {
  const trimmed = text.trim()

  if (
    trimmed.length < MIN_JSON_BLOCK_CHARS ||
    !/^[[{]/.test(trimmed) ||
    !/[\]}]$/.test(trimmed)
  ) {
    return false
  }

  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === "object" && value !== null
  } catch {
    return false
  }
}

function remove(node: Node): void {
  node.parentNode?.removeChild(node)
}

/** Takes what the page does not show out of its parsed HTML, and counts it. */
export function pruneUnshown(doc: Document): LeftOut {
  const left: LeftOut = { hidden: 0, json: 0, jsonChars: 0 }

  for (const element of Array.from(
    doc.querySelectorAll("[hidden], [aria-hidden], [style], dialog"),
  )) {
    // One inside another already taken out goes with it.
    if (isHidden(element) && element.isConnected) {
      left.hidden += 1
      remove(element)
    }
  }

  for (const block of Array.from(doc.querySelectorAll("pre, code"))) {
    if (!block.isConnected) continue

    const text = block.textContent ?? ""

    if (isJsonData(text)) {
      left.json += 1
      left.jsonChars += text.trim().length
      remove(block)
    }
  }

  return left
}

/** A page's HTML (or an element's), as read_page gives it. */
export function readableMarkdown(
  html: string,
  baseUrl: string,
): { title: string | null; markdown: string; left: LeftOut } {
  let left: LeftOut = { hidden: 0, json: 0, jsonChars: 0 }
  const { title, markdown } = htmlToMarkdown(html, baseUrl, {
    prune: (doc) => {
      left = pruneUnshown(doc)
    },
  })

  return { title, markdown, left }
}

/** What an answer says it left out, or null for nothing worth saying. */
export function leftOutNote(left: LeftOut): string | null {
  if (left.json === 0) {
    return null
  }

  return `Left out: ${left.json} block${left.json === 1 ? "" : "s"} of JSON data the page carries (${left.jsonChars.toLocaleString("en")} characters), which it does not show.`
}
