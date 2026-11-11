import { describe, expect, it } from "vitest"

import { htmlToMarkdown } from "../fetch/html"
import {
  isJsonData,
  leftOutNote,
  MIN_JSON_BLOCK_CHARS,
  readableMarkdown,
} from "./read-page"

// read_page leaves out what a page does not show: what its HTML marks as
// hidden, and code blocks that are JSON data (LinkedIn's messages page was
// nearly all of that). web_fetch's Markdown is unchanged.

const STATE = JSON.stringify({
  data: Array.from({ length: 40 }, (_, i) => ({ id: i, kind: "message" })),
})

const PAGE = `<!doctype html><title>Messaging</title>
<main>
  <h1>Messages</h1>
  <p>Ada: see you at noon</p>
  <p hidden>An old draft</p>
  <p aria-hidden="true">Decoration</p>
  <p aria-hidden="false">Still shown</p>
  <div style="color: red; display:none">Hidden by style</div>
  <div style="visibility: hidden !important">Invisible</div>
  <dialog><p>A closed dialog</p></dialog>
  <dialog open><p>An open dialog</p></dialog>
  <code style="display: none" id="bpr-guid-1">${STATE}</code>
  <code id="datalet-bpr-guid-2">${STATE}</code>
  <pre><code>${STATE}</code></pre>
  <p>Call <code>[1]</code> or <code>{"a": 1}</code> as you like.</p>
  <pre>not json, {but braces}</pre>
</main>`

describe("read_page's text", () => {
  it("leaves out what the HTML hides and code blocks of JSON, and says how much JSON", () => {
    const { title, markdown, left } = readableMarkdown(
      PAGE,
      "https://www.linkedin.com/messaging/",
    )

    expect(title).toBe("Messaging")
    expect(markdown).toContain("# Messages")
    expect(markdown).toContain("Ada: see you at noon")
    expect(markdown).toContain("Still shown")
    expect(markdown).toContain("An open dialog")
    for (const gone of [
      "An old draft",
      "Decoration",
      "Hidden by style",
      "Invisible",
      "A closed dialog",
      '"kind"',
    ]) {
      expect(markdown).not.toContain(gone)
    }
    // Short code and code that is not JSON are words, and stay.
    expect(markdown).toContain("`[1]`")
    expect(markdown).toContain('`{"a": 1}`')
    expect(markdown).toContain("not json, {but braces}")

    // The hidden code block went as hidden; the others as JSON.
    expect(left).toEqual({ hidden: 6, json: 2, jsonChars: 2 * STATE.length })
    expect(leftOutNote(left)).toBe(
      `Left out: 6 elements the page's HTML marks hidden, and 2 blocks of JSON data the page carries (${(2 * STATE.length).toLocaleString("en")} characters), which it does not show.`,
    )
    expect(leftOutNote({ hidden: 1, json: 0, jsonChars: 0 })).toBe(
      "Left out: 1 element the page's HTML marks hidden, which it does not show.",
    )
    expect(leftOutNote({ hidden: 0, json: 0, jsonChars: 0 })).toBeNull()
  })

  it("leaves web_fetch's Markdown as it was", () => {
    const { markdown } = htmlToMarkdown(PAGE, "https://example.com/")

    expect(markdown).toContain("An old draft")
    expect(markdown).toContain('"kind"')
  })

  it("counts as JSON data only an object or a list long enough to be one", () => {
    expect(isJsonData(STATE)).toBe(true)
    expect(isJsonData(`[${"1,".repeat(MIN_JSON_BLOCK_CHARS)}1]`)).toBe(true)
    expect(isJsonData("[1]")).toBe(false)
    expect(isJsonData(`"${"x".repeat(MIN_JSON_BLOCK_CHARS)}"`)).toBe(false)
    expect(isJsonData(`{${"x".repeat(MIN_JSON_BLOCK_CHARS)}}`)).toBe(false)
  })
})
