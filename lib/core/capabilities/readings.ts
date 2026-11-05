import {
  AGREEMENT_MIN,
  LOW_CONFIDENCE,
  MAX_COMPARED_CHARS,
  MAX_NAMED_NUMBERS,
} from "./limits"

/**
 * What a provider's answer says, read without knowing the provider: its
 * text (or a handle for a text too long to hand over), how sure it was, and
 * whether it is an error said as a value. Then what read_image says of
 * several readings of one picture: whether they agree, and which numbers
 * they read differently. Pure.
 */

export type Handle = { $result: string; [key: string]: unknown }

export type ReadText = {
  /** The text, or a kept result's handle for a long one. */
  text: string | Handle | null
  /** 0 to 1, when the provider said. */
  confidence: number | null
  /** An error the provider answered as a value ({"error": "…"}). */
  error: string | null
  /** Markdown where the provider said so (md_content, markdown). */
  format: "markdown" | "text"
}

/** Where providers put their text, most specific first. */
const TEXT_PATHS = [
  ["document", "md_content"],
  ["document", "text_content"],
  ["document", "markdown"],
  ["document", "text"],
  ["md_content"],
  ["text_content"],
  ["markdown"],
  ["full_text"],
  ["text"],
  ["content"],
  ["result"],
]

/** Where they say how sure they were. */
const CONFIDENCE_PATHS = [
  ["overall_average_confidence"],
  ["average_confidence"],
  ["mean_confidence"],
  ["confidence"],
  ["document", "confidence"],
  ["ocr_confidence"],
  ["score"],
]

/** Grades some providers give in place of a number. */
const GRADES: Record<string, number> = {
  poor: 0.3,
  fair: 0.6,
  good: 0.85,
  excellent: 0.95,
}

/** The fields a capability asks of a provider's answer, as call_tool's fields. */
export const READ_FIELDS = [
  ...new Set(
    [
      ...TEXT_PATHS,
      ...CONFIDENCE_PATHS,
      ["pages", "text"],
      ["page_details", "text"],
      ["error"],
      ["errors"],
      ["status"],
    ].map((path) => path.join(".")),
  ),
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isHandle(value: unknown): value is Handle {
  return isRecord(value) && typeof value.$result === "string"
}

function at(value: unknown, path: string[]): unknown {
  let found = value

  for (const part of path) {
    if (!isRecord(found)) {
      return undefined
    }

    found = found[part]
  }

  return found
}

/** A confidence as 0 to 1: a percentage, a fraction or a grade. */
function confidenceOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value > 1 ? Math.min(value / 100, 1) : value
  }

  if (typeof value === "string") {
    const grade = GRADES[value.trim().toLowerCase()]
    return grade ?? null
  }

  if (isRecord(value)) {
    for (const key of [
      "ocr_score",
      "mean_score",
      "score",
      "mean_grade",
      "ocr_grade",
      "low_grade",
      "average",
    ]) {
      const found = confidenceOf(value[key])

      if (found !== null) {
        return found
      }
    }
  }

  return null
}

/** What a provider's answer, as a value, says it read. */
export function readText(value: unknown): ReadText {
  if (typeof value === "string" || isHandle(value)) {
    return { text: value, confidence: null, error: null, format: "text" }
  }

  const error = at(value, ["error"])
  const errors = at(value, ["errors"])
  const status = at(value, ["status"])
  let text: string | Handle | null = null
  let format: ReadText["format"] = "text"

  for (const path of TEXT_PATHS) {
    const found = at(value, path)

    if ((typeof found === "string" && found.trim()) || isHandle(found)) {
      text = found as string | Handle
      format = /md|markdown/.test(path.at(-1)!) ? "markdown" : "text"
      break
    }
  }

  // Pages, each with its text.
  if (text === null) {
    const pages = at(value, ["pages"]) ?? at(value, ["page_details"])

    if (Array.isArray(pages)) {
      const parts = pages.flatMap((page) =>
        isRecord(page) && typeof page.text === "string" ? [page.text] : [],
      )
      text = parts.length > 0 ? parts.join("\n\n") : null
    }
  }

  let confidence: number | null = null

  for (const path of CONFIDENCE_PATHS) {
    confidence = confidenceOf(at(value, path))

    if (confidence !== null) {
      break
    }
  }

  const failed =
    typeof error === "string" && error.trim()
      ? error.trim()
      : text === null && status === "failure"
        ? Array.isArray(errors) && errors.length > 0
          ? JSON.stringify(errors).slice(0, 500)
          : "The provider says it failed."
        : null

  return { text, confidence, error: failed, format }
}

/** A text's words, lower case, for comparing. */
function words(text: string): string[] {
  return text
    .slice(0, MAX_COMPARED_CHARS)
    .toLowerCase()
    .replace(/[#*_`>|[\]()-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/** Dice's coefficient over two texts' words, counted as multisets. */
export function similarity(a: string, b: string): number {
  const left = words(a)
  const right = words(b)

  if (left.length === 0 && right.length === 0) {
    return 1
  }

  const counts = new Map<string, number>()

  for (const word of left) {
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }

  let shared = 0

  for (const word of right) {
    const count = counts.get(word) ?? 0

    if (count > 0) {
      shared += 1
      counts.set(word, count - 1)
    }
  }

  return (2 * shared) / (left.length + right.length)
}

/** The numbers in a text: digits, with a decimal point or comma kept. */
export function numbersIn(text: string): string[] {
  return (
    text
      .slice(0, MAX_COMPARED_CHARS)
      .match(/\d+(?:[.,]\d+)*/g)
      ?.map((number) => number.replace(/,/g, ".")) ?? []
  )
}

function multisetDifference(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>()

  for (const item of b) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }

  return a.filter((item) => {
    const count = counts.get(item) ?? 0

    if (count > 0) {
      counts.set(item, count - 1)
      return false
    }

    return true
  })
}

export type Reading = {
  provider: string
  text: string | Handle | null
  confidence: number | null
}

export type Verdict = {
  /** null when fewer than two readings could be compared. */
  agree: boolean | null
  flags: string[]
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * What several readings of one picture come to: whether they agree (their
 * words overlap at least AGREEMENT_MIN, and they read the same numbers),
 * and a flag for each disagreement, for a reading below LOW_CONFIDENCE, and
 * for a reading that was empty or too long to compare.
 */
export function compareReadings(readings: Reading[]): Verdict {
  const flags: string[] = []
  const texts = readings.filter(
    (reading): reading is Reading & { text: string } =>
      typeof reading.text === "string",
  )

  for (const reading of readings) {
    if (reading.confidence !== null && reading.confidence < LOW_CONFIDENCE) {
      flags.push(
        `Low confidence: ${reading.provider} was ${percent(reading.confidence)} sure of what it read.`,
      )
    }

    if (isHandle(reading.text)) {
      flags.push(
        `${reading.provider} read more than can be compared here: its text is the handle {"$result": "${reading.text.$result}"} (read_result reads it).`,
      )
    } else if (typeof reading.text === "string" && !reading.text.trim()) {
      flags.push(`${reading.provider} read no text at all.`)
    }
  }

  if (texts.length < 2) {
    return { agree: null, flags }
  }

  let agree = true

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!
      const b = texts[j]!
      const score = similarity(a.text, b.text)
      const onlyA = multisetDifference(numbersIn(a.text), numbersIn(b.text))
      const onlyB = multisetDifference(numbersIn(b.text), numbersIn(a.text))

      if (onlyA.length > 0 || onlyB.length > 0) {
        agree = false
        const named = (list: string[]) =>
          list.length === 0
            ? "none the other lacks"
            : list.slice(0, MAX_NAMED_NUMBERS).join(", ") +
              (list.length > MAX_NAMED_NUMBERS ? ", …" : "")
        flags.push(
          `The numbers differ: ${a.provider} read ${named(onlyA)}; ${b.provider} read ${named(onlyB)}. Look at the picture before you use any of them.`,
        )
      }

      if (score < AGREEMENT_MIN) {
        agree = false
        flags.push(
          `The readings differ: ${a.provider} and ${b.provider} share ${percent(score)} of their words.`,
        )
      }
    }
  }

  return { agree, flags }
}

/** What read_image says with every reading, flagged or not. */
export const CHECK_NUMBERS =
  "Check digits, meter readings, amounts, dates and codes against the picture itself before you rely on them: OCR mixes up 0 and O, 1, l and 7, 5 and S, 8 and B, and drops or adds a decimal point."
