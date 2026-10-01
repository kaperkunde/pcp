/**
 * Keeping a credential out of what an API answers. An API that echoes a key
 * back (an error such as "Invalid key: sk-…", a debugging endpoint that
 * reflects headers, a status line, a redirect that puts it in the path) must
 * not hand it to the assistant, so PCP removes it from every string it builds
 * from an answer.
 *
 * Each value is removed as it is, and in the forms JSON encoders write it:
 * with quotes and backslashes escaped; with "/" as "\/" (PHP); with "<", ">"
 * and "&" as <, >, & (Go); with non-ASCII as \uXXXX (Python,
 * PHP). A parsed JSON value is walked as well, which catches any escaping the
 * parser decodes. The longest variant goes first so a header value is not
 * left half-redacted around the key it contains.
 */

const REDACTED = "[redacted]"
/** Shorter values would mangle ordinary text more often than they protect. */
const MIN_REDACTED_LENGTH = 4
const MAX_WALK_DEPTH = 500

function variantsOf(value: string): string[] {
  const found = new Set<string>()

  for (const base of [value, JSON.stringify(value).slice(1, -1)]) {
    const goStyle = base.replace(
      /[<>&]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )

    for (const form of [base, goStyle]) {
      found.add(form)
      found.add(form.replace(/\//g, "\\/"))
    }

    found.add(
      base.replace(
        /[^\x20-\x7e]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    )
  }

  return [...found]
}

export type Redactor = {
  /** `truncated`: the text was cut, so it may end partway through a key. */
  text: (input: string, options?: { truncated?: boolean }) => string
  /** A parsed JSON value with every string and key cleaned. */
  value: (input: unknown) => unknown
}

export function makeRedactor(values: string[]): Redactor {
  const variants = [
    ...new Set(
      values
        .filter((value) => value.length >= MIN_REDACTED_LENGTH)
        .flatMap(variantsOf),
    ),
  ].sort((a, b) => b.length - a.length)

  if (variants.length === 0) {
    return { text: (input) => input, value: (input) => input }
  }

  const text: Redactor["text"] = (input, { truncated = false } = {}) => {
    let result = input

    for (const variant of variants) {
      if (result.includes(variant)) {
        result = result.split(variant).join(REDACTED)
      }
    }

    // A text cut at the size limit can end partway through the key, which
    // the whole-value pass cannot see: drop the start of it too.
    if (truncated) {
      for (const variant of variants) {
        for (
          let length = variant.length - 1;
          length >= MIN_REDACTED_LENGTH;
          length--
        ) {
          if (result.endsWith(variant.slice(0, length))) {
            result = `${result.slice(0, -length)}${REDACTED}`
            break
          }
        }
      }
    }

    return result
  }

  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") {
      return text(input)
    }

    if (typeof input !== "object" || input === null) {
      return input
    }

    if (depth > MAX_WALK_DEPTH) {
      return "[nested too deeply]"
    }

    if (Array.isArray(input)) {
      return input.map((item) => walk(item, depth + 1))
    }

    const out: Record<string, unknown> = {}

    for (const [key, item] of Object.entries(input)) {
      // JSON.parse makes "__proto__" an own property; assigning it would
      // replace the prototype instead.
      if (key !== "__proto__") {
        out[text(key)] = walk(item, depth + 1)
      }
    }

    return out
  }

  return { text, value: (input) => walk(input, 0) }
}

export function redactSecrets(
  input: string,
  values: string[],
  options: { truncated?: boolean } = {},
): string {
  return makeRedactor(values).text(input, options)
}
