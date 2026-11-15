import { describe, expect, it } from "vitest"

import { compareReadings, numbersIn, readText, similarity } from "./readings"

describe("what a provider read", () => {
  it("reads a converter's Markdown, an OCR tool's text and confidence, and an error said as a value", () => {
    expect(
      readText({
        document: { md_content: "# Meter\n\n04512.7 kWh" },
        status: "success",
      }),
    ).toEqual({
      text: "# Meter\n\n04512.7 kWh",
      confidence: null,
      error: null,
      format: "markdown",
    })
    expect(
      readText({ text: "04512.7 kWh", overall_average_confidence: 71.5 }),
    ).toEqual({
      text: "04512.7 kWh",
      confidence: 0.715,
      error: null,
      format: "text",
    })
    expect(readText({ error: "file_path: no such file" }).error).toBe(
      "file_path: no such file",
    )
    expect(
      readText({ document: { confidence: { mean_grade: "poor" } }, text: "x" })
        .confidence,
    ).toBe(0.3)
    expect(readText({ status: "failure", errors: [] }).error).toBe(
      "The provider says it failed.",
    )
    expect(readText({ pages: [{ text: "one" }, { text: "two" }] }).text).toBe(
      "one\n\ntwo",
    )
  })
})

describe("several readings of one picture", () => {
  it("agree when their words and numbers are the same", () => {
    expect(
      compareReadings([
        { provider: "a/ocr", text: "Meter 04512.7 kWh", confidence: 0.95 },
        { provider: "b/ocr", text: "meter 04512.7 kWh", confidence: null },
      ]),
    ).toEqual({ agree: true, flags: [] })
  })

  it("flag a number read differently, words that differ, and a reading that was unsure", () => {
    const verdict = compareReadings([
      { provider: "a/ocr", text: "Meter 04512.7 kWh", confidence: 0.92 },
      { provider: "b/ocr", text: "Meter 04517.7 kWh", confidence: 0.64 },
    ])

    expect(verdict.agree).toBe(false)
    expect(verdict.flags).toEqual([
      "Low confidence: b/ocr was 64% sure of what it read.",
      "The numbers differ: a/ocr read 04512.7; b/ocr read 04517.7. Look at the picture before you use any of them.",
      "The readings differ: a/ocr and b/ocr share 67% of their words.",
    ])
  })

  it("compare nothing with one reading, and say so of a handle", () => {
    expect(
      compareReadings([
        {
          provider: "a/ocr",
          text: { $result: "r1", type: "text/plain" },
          confidence: null,
        },
      ]),
    ).toEqual({
      agree: null,
      flags: [
        'a/ocr read more than can be compared here: its text is the handle {"$result": "r1"} (read_result reads it).',
      ],
    })
  })

  it("count words and numbers as they are read", () => {
    expect(similarity("a b c", "a b d")).toBeCloseTo(2 / 3)
    expect(numbersIn("Total 1,234.50 on 12-03")).toEqual([
      "1.234.50",
      "12",
      "03",
    ])
  })
})
