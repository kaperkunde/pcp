import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Page } from "patchright-core"
import { describe, expect, it } from "vitest"

import {
  holdSecret,
  maskTyped,
  maskTypedIn,
  maskTypedResult,
  normalised,
} from "./held"

// A secret PCP typed, found again in what a page writes back: as it is, or
// as the page wrote it its own way (spaced, dashed, upper case), within a
// word or across several, on any of the token's tabs. Only keyed hashes are
// kept, and a long answer costs arithmetic per character, not a hash.

const IBAN = "NL91ABNA0417164300"

function page(): Page {
  return {} as Page
}

describe("a typed secret written back reformatted", () => {
  it("reads text without white space and separators, upper case, and knows where each character came from", () => {
    const { chars, start, end } = normalised("nl91 abna-0417.16/43\u00a000")
    expect(chars).toBe(IBAN)
    expect(start[0]).toBe(0)
    expect(start[4]).toBe(5)
    expect(end[chars.length - 1]).toBe(23)
  })

  it("is masked spaced, dashed, in lower case and within a longer text", () => {
    const tab = page()
    holdSecret(tab, "Bank", IBAN)

    expect(maskTyped(tab, "To NL91 ABNA 0417 1643 00, thanks")).toBe(
      "To [secret: Bank], thanks",
    )
    expect(maskTyped(tab, "iban: nl91-abna-0417-1643-00.")).toBe(
      "iban: [secret: Bank].",
    )
    expect(maskTyped(tab, `ref${IBAN}x`)).toBe("ref[secret: Bank]x")
    expect(maskTyped(tab, `${IBAN} and NL91 ABNA 0417 1643 00`)).toBe(
      "[secret: Bank] and [secret: Bank]",
    )
    // Another account at the same bank stays.
    expect(maskTyped(tab, "NL20 ABNA 0417 1643 99")).toBe(
      "NL20 ABNA 0417 1643 99",
    )
  })

  it("is found from the value as the field had it reformatted too", () => {
    const tab = page()
    holdSecret(tab, "Bank", "NL91 ABNA 0417 1643 00")

    expect(maskTyped(tab, `Paid from ${IBAN.toLowerCase()}`)).toBe(
      "Paid from [secret: Bank]",
    )
  })

  it("leaves a short value to whole words, so ordinary text stays", () => {
    const tab = page()
    holdSecret(tab, "Pin", "4321")

    expect(maskTyped(tab, "pin 4321 ok")).toBe("pin [secret: Pin] ok")
    expect(maskTyped(tab, "call 0043 21 or 1432100")).toBe(
      "call 0043 21 or 1432100",
    )
  })

  it("masks every string of an answer with what any of the tabs had typed, and leaves images", () => {
    const login = page()
    const other = page()
    holdSecret(login, "Bank", IBAN)

    const result: CallToolResult = {
      content: [
        { type: "text", text: "Summary: NL91 ABNA 0417 1643 00" },
        { type: "image", data: IBAN, mimeType: "image/png" },
      ],
      structuredContent: { from: "nl91abna0417164300", list: ["x"] },
    }

    expect(maskTypedResult([other], result)).toBe(result)
    const masked = maskTypedResult([other, login], result)
    expect(masked.content[0]).toEqual({
      type: "text",
      text: "Summary: [secret: Bank]",
    })
    expect(masked.content[1]).toEqual(result.content[1])
    expect(masked.structuredContent).toEqual({
      from: "[secret: Bank]",
      list: ["x"],
    })
  })

  it("keeps up on a large page", () => {
    const tab = page()
    holdSecret(tab, "Bank", IBAN)
    holdSecret(tab, "Shop", "hunter2-very-secret")
    const filler = "lorem ipsum dolor sit amet 0123 4567 ".repeat(25_000)
    const text = `${filler}NL91 ABNA 0417 1643 00${filler}hunter2 very secret`

    const started = performance.now()
    const masked = maskTypedIn([tab], text)
    const took = performance.now() - started

    expect(masked.endsWith("[secret: Bank]" + filler + "[secret: Shop]")).toBe(
      true,
    )
    expect(masked.length).toBe(
      2 * filler.length + "[secret: Bank][secret: Shop]".length,
    )
    // About a million and a half characters, two lengths: arithmetic, with
    // a hash only where a fingerprint matched.
    expect(took).toBeLessThan(5_000)
  })
})
