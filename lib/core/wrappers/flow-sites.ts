/**
 * The sites a browser flow's program opens, for the owner's review of a
 * wrapper_change request: a best-effort reading of the program's text, not
 * a promise. It finds each `pcp.call(<browser>, "tabs" | "navigate", {…})`
 * and reads its `url`: a string literal is a site, and so is the fixed
 * start of a template (`https://mail.example.com/${…}`); an address taken
 * from the arguments, or worked out as it runs, is said to be so. A program
 * can reach a site in ways this does not see (a variable for the tool's
 * name, a link it clicks), which the page says; what the browser opens is
 * still decided by the calling token's own site levels, whatever this says.
 */

export type FlowSites = {
  /** Hosts named in the program's text, in the order they first appear. */
  sites: string[]
  /** An address comes from the tool's arguments (`args`). */
  fromArguments: boolean
  /** An address is worked out some other way as it runs. */
  computed: boolean
}

const OPENS = new Set(["tabs", "navigate"])
/** How many calls one program is read for, past which the rest are skipped. */
const MAX_CALLS_READ = 200
const MAX_SITES = 50

/**
 * Where the expression that starts at `from` ends: the index of the first
 * top-level `,` or of the closing bracket that is not its own, skipping
 * strings, templates and comments.
 */
function endOfExpression(text: string, from: number): number {
  let depth = 0
  let at = from

  while (at < text.length) {
    const char = text[at]!

    if (char === '"' || char === "'") {
      at = endOfQuoted(text, at)
      continue
    }

    if (char === "`") {
      at = endOfTemplate(text, at)
      continue
    }

    if (char === "/" && text[at + 1] === "/") {
      const newline = text.indexOf("\n", at)
      at = newline === -1 ? text.length : newline
      continue
    }

    if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2)
      at = close === -1 ? text.length : close + 2
      continue
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        return at
      }

      depth -= 1
    } else if (char === "," && depth === 0) {
      return at
    }

    at += 1
  }

  return at
}

/** Past the quote that closes the string opened at `from`. */
function endOfQuoted(text: string, from: number): number {
  const quote = text[from]
  let at = from + 1

  while (at < text.length && text[at] !== quote && text[at] !== "\n") {
    at += text[at] === "\\" ? 2 : 1
  }

  return at + 1
}

/** Past the backtick that closes the template opened at `from`. */
function endOfTemplate(text: string, from: number): number {
  let at = from + 1

  while (at < text.length && text[at] !== "`") {
    if (text[at] === "\\") {
      at += 2
    } else if (text[at] === "$" && text[at + 1] === "{") {
      at = endOfExpression(text, at + 2) + 1
    } else {
      at += 1
    }
  }

  return at + 1
}

/** A string literal's text, or null for anything else. */
function literal(expression: string): string | null {
  const text = expression.trim()
  const quote = text[0]

  if (
    text.length < 2 ||
    (quote !== '"' && quote !== "'" && quote !== "`") ||
    text.at(-1) !== quote ||
    endOfLiteral(text) !== text.length
  ) {
    return null
  }

  const inner = text.slice(1, -1)

  if (quote === "`" && inner.includes("${")) {
    return null
  }

  return inner.replace(/\\(.)/g, "$1")
}

function endOfLiteral(text: string): number {
  return text[0] === "`" ? endOfTemplate(text, 0) : endOfQuoted(text, 0)
}

/** A template's text up to its first `${`, or null when it is not one. */
function templateStart(expression: string): string | null {
  const text = expression.trim()

  if (text[0] !== "`" || endOfTemplate(text, 0) !== text.length) {
    return null
  }

  const at = text.indexOf("${")
  return at === -1 ? null : text.slice(1, at).replace(/\\(.)/g, "$1")
}

/**
 * The host a fixed address names, or the fixed start of one: there the host
 * counts only when something ends it (a slash, ? or #), since what follows
 * could still be part of it.
 */
function hostOf(address: string, whole: boolean): string | null {
  const match = new RegExp(
    `^https?://([^/?#\\s]+)(?=[/?#]${whole ? "|$" : ""})`,
    "i",
  ).exec(address)

  if (!match) {
    return null
  }

  try {
    return new URL(`https://${match[1]}`).host || null
  } catch {
    return null
  }
}

const EDGE_COMMENT = /^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))/

/** An expression without the whitespace and comments around it. */
function bare(expression: string): string {
  let text = expression

  for (let match = EDGE_COMMENT.exec(text); match;) {
    text = text.slice(match[0].length)
    match = EDGE_COMMENT.exec(text)
  }

  // One after it, as in `"tabs" /* or navigate */`.
  return text.replace(/\s*\/\*[\s\S]*?\*\/\s*$/, "").trim()
}

/** The top-level arguments of the call whose `(` is at `open`. */
function callArguments(text: string, open: number): string[] {
  const parts: string[] = []
  let at = open + 1

  while (at < text.length && parts.length < 4) {
    const end = endOfExpression(text, at)
    parts.push(bare(text.slice(at, end)))

    if (text[end] !== ",") {
      break
    }

    at = end + 1
  }

  return parts
}

/** The text of an object literal's top-level `url` property, if it has one. */
function urlProperty(objectText: string): string | "shorthand" | null {
  const text = objectText.trim()

  if (text[0] !== "{") {
    return null
  }

  let at = 1

  while (at < text.length) {
    const end = endOfExpression(text, at)
    const entry = bare(text.slice(at, end))
    const match = /^(?:url|"url"|'url')\s*(:)?/.exec(entry)

    if (match) {
      return match[1] ? entry.slice(match[0].length) : "shorthand"
    }

    if (text[end] !== ",") {
      break
    }

    at = end + 1
  }

  return null
}

/**
 * The sites one program opens through the browser servers named `browsers`
 * (their short names), as far as its text says.
 */
export function flowSites(program: string, browsers: string[]): FlowSites {
  const found: FlowSites = { sites: [], fromArguments: false, computed: false }
  const pattern = /\bpcp\s*\.\s*call\s*\(/g
  const mentionsArgs = (text: string) => /\bargs\b/.test(text)
  let calls = 0

  const addressFrom = (expression: string) => {
    const fixed = literal(expression)
    const start = fixed === null ? templateStart(expression) : null
    const host =
      fixed !== null
        ? hostOf(fixed, true)
        : start !== null
          ? hostOf(start, false)
          : null

    if (host) {
      // The site is fixed, even where the rest of the address is not.
      if (!found.sites.includes(host) && found.sites.length < MAX_SITES) {
        found.sites.push(host)
      }
    } else if (mentionsArgs(expression)) {
      found.fromArguments = true
    } else {
      found.computed = true
    }
  }

  for (const match of program.matchAll(pattern)) {
    if (++calls > MAX_CALLS_READ) {
      found.computed = true
      break
    }

    const [server, tool, options] = callArguments(
      program,
      match.index + match[0].length - 1,
    )
    const serverName = literal(server ?? "")
    const toolName = literal(tool ?? "")

    if (serverName === null || toolName === null) {
      // pcp.call(someServer, someTool, …): it could be the browser.
      if (browsers.length > 0) {
        found.computed = true
      }

      continue
    }

    if (!browsers.includes(serverName) || !OPENS.has(toolName)) {
      continue
    }

    if (options === undefined) {
      continue
    }

    const url = urlProperty(options)

    if (url === "shorthand") {
      found.computed = true
    } else if (url !== null) {
      addressFrom(url)
    } else if (options.trim()[0] !== "{") {
      // The arguments as a whole are a variable, args among them maybe.
      if (mentionsArgs(options)) {
        found.fromArguments = true
      } else {
        found.computed = true
      }
    }
  }

  return found
}
