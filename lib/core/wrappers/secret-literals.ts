import type { SecretPart } from "./placeholders"

/**
 * The secrets a wrapper tool's program names as they are written: every
 * object literal of the form {"$secret": "<name>"} (or {$secret: '<name>'},
 * with "part": "username" or not) whose name is a string literal. A name the
 * program works out as it runs ({$secret: args.which}, a template with
 * `${…}`, a name joined from parts) is not found, and so is never derived
 * (definition.ts): it still needs a place the owner approved by name.
 *
 * A conservative reading of the program's text, not a parse: comments are
 * skipped, strings, templates and regular expressions read as such, and an
 * object counted only where its `$secret` key sits at its own top level
 * after `{` or `,`. What it finds is shown to the owner on the wrapper's
 * review, who approves it with the rest; what it misses only means a typing
 * that is refused with how to fix it (run.ts). Pure: it reads no secret and
 * touches no database.
 */

export type SecretLiteral = {
  name: string
  /** What the program types of it, in a stable order. */
  parts: SecretPart[]
}

type Token =
  | { kind: "punct"; value: string }
  | { kind: "ident"; value: string }
  /** value is null when the string is not fixed (a template with `${…}`). */
  | { kind: "string"; value: string | null }
  | { kind: "other" }

/** Past this many tokens the rest of a program is not read. */
const MAX_TOKENS = 200_000
/** At most this many names are taken from one program. */
const MAX_FOUND = 50

/** After these words a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
])

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/

/** A quoted string's text with its escapes read, or null for an odd one. */
function unescape(raw: string): string | null {
  let out = ""

  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at]!

    if (char !== "\\") {
      out += char
      continue
    }

    const next = raw[at + 1]
    at += 1

    switch (next) {
      case "n":
        out += "\n"
        break
      case "r":
        out += "\r"
        break
      case "t":
        out += "\t"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "v":
        out += "\v"
        break
      case "0":
        out += "\0"
        break
      case "x": {
        const hex = raw.slice(at + 1, at + 3)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
        out += String.fromCharCode(parseInt(hex, 16))
        at += 2
        break
      }
      case "u": {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(raw.slice(at + 1))
        if (braced) {
          const code = parseInt(braced[1]!, 16)
          if (code > 0x10ffff) return null
          out += String.fromCodePoint(code)
          at += braced[0].length
          break
        }
        const hex = raw.slice(at + 1, at + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
        out += String.fromCharCode(parseInt(hex, 16))
        at += 4
        break
      }
      case "\n":
        // A line continuation adds nothing.
        break
      case undefined:
        return null
      default:
        out += next
    }
  }

  return out
}

/** The tokens of `text` from `from`, up to an unmatched `}` when `inner`. */
function tokenize(
  text: string,
  from: number,
  inner: boolean,
  tokens: Token[],
): number {
  let at = from
  let depth = 0

  const previous = (): Token | undefined => tokens.at(-1)
  const regexAllowed = (): boolean => {
    const last = previous()

    if (!last) return true
    if (last.kind === "punct") return !/^[)\]}]$/.test(last.value)
    if (last.kind === "ident") return BEFORE_REGEX.has(last.value)
    return false
  }

  while (at < text.length) {
    if (tokens.length > MAX_TOKENS) {
      return text.length
    }

    const char = text[at]!

    if (/\s/.test(char)) {
      at += 1
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

    if (char === '"' || char === "'") {
      let end = at + 1

      while (end < text.length && text[end] !== char && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1
      }

      const closed = text[end] === char
      tokens.push({
        kind: "string",
        value: closed ? unescape(text.slice(at + 1, end)) : null,
      })
      at = end + 1
      continue
    }

    if (char === "`") {
      let end = at + 1
      let fixed = true

      while (end < text.length && text[end] !== "`") {
        if (text[end] === "\\") {
          end += 2
        } else if (text[end] === "$" && text[end + 1] === "{") {
          fixed = false
          // What is inside is read too, and its own objects counted.
          end = tokenize(text, end + 2, true, tokens) + 1
        } else {
          end += 1
        }
      }

      tokens.push({
        kind: "string",
        value:
          fixed && text[end] === "`" ? unescape(text.slice(at + 1, end)) : null,
      })
      at = end + 1
      continue
    }

    if (char === "/" && regexAllowed()) {
      let end = at + 1
      let inClass = false

      while (end < text.length && text[end] !== "\n") {
        const here = text[end]!

        if (here === "\\") {
          end += 2
          continue
        }

        if (here === "[") inClass = true
        else if (here === "]") inClass = false
        else if (here === "/" && !inClass) break

        end += 1
      }

      end += 1

      while (end < text.length && IDENT_PART.test(text[end]!)) {
        end += 1
      }

      tokens.push({ kind: "other" })
      at = end
      continue
    }

    if (IDENT_START.test(char)) {
      let end = at + 1

      while (end < text.length && IDENT_PART.test(text[end]!)) {
        end += 1
      }

      tokens.push({ kind: "ident", value: text.slice(at, end) })
      at = end
      continue
    }

    if (/[0-9]/.test(char)) {
      let end = at + 1

      while (end < text.length && /[0-9A-Za-z_.]/.test(text[end]!)) {
        end += 1
      }

      tokens.push({ kind: "other" })
      at = end
      continue
    }

    if (char === "." && text.slice(at, at + 3) === "...") {
      tokens.push({ kind: "punct", value: "..." })
      at += 3
      continue
    }

    if (inner) {
      if (char === "{") {
        depth += 1
      } else if (char === "}") {
        if (depth === 0) {
          return at
        }

        depth -= 1
      }
    }

    tokens.push({ kind: "punct", value: char })
    at += 1
  }

  return at
}

type Frame = {
  bracket: "{" | "(" | "["
  /** The literal name of its $secret key; null when it is not fixed. */
  secret?: string | null
  /** Its part key: a literal, or null when it is not fixed. */
  part?: SecretPart | null
  /** It has a key that a placeholder does not take. */
  other?: boolean
}

const CLOSE: Record<string, Frame["bracket"]> = { "}": "{", ")": "(", "]": "[" }

function keyOf(token: Token | undefined): string | null {
  if (!token) return null
  if (token.kind === "ident") return token.value
  if (token.kind === "string") return token.value
  return null
}

function isPunct(token: Token | undefined, ...values: string[]): boolean {
  return token?.kind === "punct" && values.includes(token.value)
}

/**
 * Every secret a program names as {"$secret": "<name>"}, each once, with
 * the parts it types of it; in the order they first appear.
 */
export function secretLiterals(program: string): SecretLiteral[] {
  const tokens: Token[] = []
  tokenize(program, 0, false, tokens)

  const found = new Map<string, Set<SecretPart>>()
  const stack: Frame[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!

    if (token.kind === "punct") {
      if (token.value === "{" || token.value === "(" || token.value === "[") {
        stack.push({ bracket: token.value })
        continue
      }

      const opens = CLOSE[token.value]

      if (opens) {
        // Pop to the bracket this one closes, so a stray one costs a frame,
        // not the reading of the rest.
        let frame = stack.pop()

        while (frame && frame.bracket !== opens) {
          frame = stack.pop()
        }

        if (
          frame?.bracket === "{" &&
          typeof frame.secret === "string" &&
          !frame.other &&
          (found.has(frame.secret) || found.size < MAX_FOUND)
        ) {
          const parts = found.get(frame.secret) ?? new Set<SecretPart>()
          // A part worked out as it runs may be either.
          if (frame.part === null) {
            parts.add("username")
            parts.add("password")
          } else {
            parts.add(frame.part ?? "password")
          }
          found.set(frame.secret, parts)
        }

        continue
      }

      if (token.value === "..." && stack.at(-1)?.bracket === "{") {
        stack.at(-1)!.other = true
      }

      continue
    }

    const frame = stack.at(-1)

    // A key at an object's own top level: `{` or `,` before it, `:` after.
    if (
      frame?.bracket !== "{" ||
      !isPunct(tokens[index - 1], "{", ",") ||
      !isPunct(tokens[index + 1], ":")
    ) {
      continue
    }

    const key = keyOf(token)
    const value = tokens[index + 2]
    const fixed =
      value?.kind === "string" && isPunct(tokens[index + 3], ",", "}")
        ? value.value
        : null

    if (key === "$secret") {
      frame.secret = fixed
    } else if (key === "part") {
      frame.part = fixed === "username" || fixed === "password" ? fixed : null
    } else {
      frame.other = true
    }
  }

  return [...found].map(([name, parts]) => ({
    name,
    parts: (["username", "password"] as const).filter((part) =>
      parts.has(part),
    ),
  }))
}
