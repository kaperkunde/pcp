/**
 * HTML mail made readable as plain text for an assistant: tags dropped,
 * block elements on lines of their own, links followed by their address,
 * entities decoded, blank runs squeezed. A single pass over the text with
 * indexOf, and what a link's words are checked against is capped
 * (`LINK_LOOKAHEAD`), so no input makes it slow. The output is only ever read,
 * never rendered, so this is about legibility, not safety.
 */

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
])
/** Lines in a list or a table: one line each, no blank line between. */
const LINE = new Set(["dd", "dt", "li", "tr"])
/** Their content is not text at all. */
const SKIPPED = new Set([
  "head",
  "script",
  "style",
  "template",
  "title",
  "noscript",
])

/**
 * How much of a link's words are looked at to see whether they already show
 * its address. Unclosed or nested anchors before a large block of text would
 * otherwise each cost the whole text.
 */
const LINK_LOOKAHEAD = 2000

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  shy: "",
  zwnj: "",
  zwj: "",
  lrm: "",
  rlm: "",
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10)

        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : ""
      }

      return NAMED[body.toLowerCase()] ?? whole
    },
  )
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag)

  return match ? (match[2] ?? match[3] ?? match[4] ?? null) : null
}

export function htmlToText(
  html: string,
  maxChars = Number.POSITIVE_INFINITY,
): { text: string; truncated: boolean } {
  const out: string[] = []
  let length = 0
  let i = 0
  const links: Array<{ href: string | null; start: number }> = []
  const lower = html.toLowerCase()
  let listDepth = 0

  let last = ""
  const push = (piece: string) => {
    if (!piece) {
      return
    }

    out.push(piece)
    length += piece.length
    last = piece[piece.length - 1]!
  }

  while (i < html.length && length <= maxChars * 2) {
    const open = html.indexOf("<", i)

    if (open === -1) {
      push(collapse(html.slice(i)))
      break
    }

    if (open > i) {
      push(collapse(html.slice(i, open)))
    }

    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }

    const close = html.indexOf(">", open + 1)

    if (close === -1) {
      push(collapse(html.slice(open)))
      break
    }

    const tag = html.slice(open, close + 1)
    const match = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)/i.exec(tag)
    i = close + 1

    if (!match) {
      continue
    }

    const closing = match[1] === "/"
    const name = match[2]!.toLowerCase()

    if (!closing && SKIPPED.has(name)) {
      const end = lower.indexOf(`</${name}`, i)
      const after = end === -1 ? -1 : html.indexOf(">", end)
      i = after === -1 ? html.length : after + 1
      continue
    }

    if (name === "a") {
      if (closing) {
        const link = links.pop()
        const href = link?.href

        if (link && href && /^(https?:|mailto:)/i.test(href)) {
          // The address goes after the words, unless they already are it.
          let shown = ""

          for (
            let n = link.start;
            n < out.length && shown.length < LINK_LOOKAHEAD;
            n++
          ) {
            shown += out[n]
          }

          if (!shown.includes(href.replace(/^mailto:/i, ""))) {
            push(` (${href})`)
          }
        }
      } else {
        links.push({ href: attribute(tag, "href"), start: out.length })
      }
      continue
    }

    if (name === "img" && !closing) {
      const alt = attribute(tag, "alt")

      if (alt) {
        push(`[${collapse(alt)}]`)
      }
      continue
    }

    if (name === "ul" || name === "ol") {
      listDepth = Math.max(0, listDepth + (closing ? -1 : 1))
    }

    if (BLOCK.has(name)) {
      if (!(LINE.has(name) && last === "\n")) {
        push("\n")
      }

      if (name === "li" && !closing) {
        push(`${"  ".repeat(Math.max(0, listDepth - 1))}- `)
      }

      if ((name === "td" || name === "th") && !closing) {
        push(" ")
      }
    }
  }

  const text = decodeEntities(out.join(""))
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false }
}

/** Whitespace in HTML text is one space, whatever it was. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ")
}
