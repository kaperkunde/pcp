import domino from "@mixmark-io/domino"
import TurndownService from "turndown"

import { CHARSET_SNIFF_BYTES, MAX_TITLE_CHARS } from "./limits"

/**
 * What web_fetch makes of a page: the bytes decoded with the charset the
 * page declares, HTML as Markdown (what an assistant reads best, and a
 * fraction of the size), and the text a part at a time.
 *
 * HTML is parsed into a document that is never rendered: no script runs and
 * nothing it links to is loaded. Scripts, styles, frames and embedded
 * objects are dropped before conversion, and links and images are made
 * absolute against the address the page came from, so they still work out
 * of context.
 */

const DROPPED =
  "script, style, noscript, template, iframe, frame, frameset, object, embed, applet, svg, canvas, link, meta, base, head"

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])
const IMAGE_PROTOCOLS = new Set(["http:", "https:"])

export function isHtml(type: string): boolean {
  return type === "text/html" || type === "application/xhtml+xml"
}

/** For an answer without a content type: whether it reads as HTML. */
export function looksLikeHtml(bytes: Buffer): boolean {
  const start = bytes
    .subarray(0, 512)
    .toString("latin1")
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase()

  return start.startsWith("<!doctype html") || start.startsWith("<html")
}

function charsetOf(contentType: string): string | null {
  return /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? null
}

function sniffMetaCharset(bytes: Buffer): string | null {
  const head = bytes.subarray(0, CHARSET_SNIFF_BYTES).toString("latin1")

  return /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ?? null
}

function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label)
  } catch {
    // A charset the runtime does not know: UTF-8 is the likeliest truth.
    return new TextDecoder("utf-8")
  }
}

/**
 * Text from an answer's bytes: a byte order mark first, then the charset in
 * the content type, then, for HTML, a <meta charset>, then UTF-8. Bytes
 * that do not decode become U+FFFD rather than an error.
 */
export function decodeBody(
  bytes: Buffer,
  contentType: string,
  html: boolean,
): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decoderFor("utf-16be").decode(bytes)
  }

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decoderFor("utf-16le").decode(bytes)
  }

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decoderFor("utf-8").decode(bytes)
  }

  const label =
    charsetOf(contentType) ?? (html ? sniffMetaCharset(bytes) : null)

  return decoderFor(label ?? "utf-8").decode(bytes)
}

function absolute(
  value: string | null,
  base: string,
  allowed: Set<string>,
): string | null {
  if (!value?.trim()) {
    return null
  }

  try {
    const url = new URL(value.trim(), base)
    return allowed.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

let service: TurndownService | null = null

function turndown(): TurndownService {
  if (service) {
    return service
  }

  service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
  })
  // An icon with no words gives "[](https://…)": noise, not a link to read.
  service.addRule("emptyLink", {
    filter: (node) =>
      node.nodeName === "A" &&
      !node.textContent?.trim() &&
      !node.querySelector("img"),
    replacement: () => "",
  })
  service.remove(["script", "style", "noscript", "template"])

  return service
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function htmlToMarkdown(
  html: string,
  baseUrl: string,
): { title: string | null; markdown: string } {
  const doc = domino.createDocument(html)
  const title = collapse(doc.title ?? "").slice(0, MAX_TITLE_CHARS) || null

  for (const node of Array.from(doc.querySelectorAll(DROPPED))) {
    node.parentNode?.removeChild(node)
  }

  for (const link of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = absolute(link.getAttribute("href"), baseUrl, LINK_PROTOCOLS)

    if (href) {
      link.setAttribute("href", href)
    } else {
      // javascript: and the like: keep the words, drop the target.
      link.removeAttribute("href")
    }
  }

  for (const image of Array.from(doc.querySelectorAll("img"))) {
    const src = absolute(image.getAttribute("src"), baseUrl, IMAGE_PROTOCOLS)

    if (src) {
      image.setAttribute("src", src)
    } else {
      // A data: image is bytes an assistant cannot use; its alt is words.
      const alt = collapse(image.getAttribute("alt") ?? "")
      image.parentNode?.replaceChild(doc.createTextNode(alt), image)
    }
  }

  const root = doc.body ?? doc.documentElement
  const markdown = root ? turndown().turndown(root) : ""

  return {
    title,
    markdown: markdown
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  }
}

/**
 * One part of a long text, in UTF-16 code units (what start_index counts),
 * never ending between the two halves of a surrogate pair.
 */
export function sliceText(
  text: string,
  start: number,
  max: number,
): { part: string; start: number; end: number; total: number } {
  const total = text.length
  const from = Math.min(start, total)
  let end = Math.min(from + max, total)

  if (end < total && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) {
    end -= 1
  }

  return { part: text.slice(from, end), start: from, end, total }
}
