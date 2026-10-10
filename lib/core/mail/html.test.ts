import { describe, expect, it } from "vitest"

import { decodeEntities, htmlToText } from "./html"

describe("htmlToText", () => {
  it("keeps the words, one block to a line", () => {
    expect(
      htmlToText(
        "<html><head><title>x</title><style>p{color:red}</style></head><body><h1>Hello</h1><p>One <b>bold</b>   word.</p><div>Two<br>lines</div></body></html>",
      ),
    ).toEqual({
      text: "Hello\n\nOne bold word.\n\nTwo\nlines",
      truncated: false,
    })
  })

  it("follows a link's words with its address", () => {
    expect(
      htmlToText('<p><a href="https://example.com/verify?t=1">Verify</a></p>')
        .text,
    ).toBe("Verify (https://example.com/verify?t=1)")
    expect(
      htmlToText('<a href="https://example.com">https://example.com</a>').text,
    ).toBe("https://example.com")
  })

  it("drops scripts, comments and tags it does not know", () => {
    expect(
      htmlToText(
        '<!-- hidden --><script>alert("x")</script><custom-tag>kept</custom-tag><img src="a.png" alt="Logo">',
      ).text,
    ).toBe("kept[Logo]")
  })

  it("lists items", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>").text).toBe(
      "- one\n- two",
    )
  })

  it("decodes entities", () => {
    expect(
      decodeEntities("Fish &amp; chips &lt;3 &#8364;5 &#x2014; &nbsp;&bogus;"),
    ).toBe("Fish & chips <3 €5 — \u0020&bogus;")
  })

  it("stops at the limit and says so", () => {
    expect(htmlToText(`<p>${"word ".repeat(100)}</p>`, 20)).toEqual({
      text: "word word word word ",
      truncated: true,
    })
  })

  it("stays quick on input made to be slow", () => {
    const started = Date.now()
    htmlToText("<style>".repeat(20_000) + "<a href=x>".repeat(20_000))
    htmlToText("<".repeat(200_000))
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("does not cost the text again for every open link", () => {
    const html =
      "<a href=http://x>".repeat(5_000) +
      "word ".repeat(380_000) +
      "</a>".repeat(5_000)
    const started = Date.now()
    const { text } = htmlToText(html)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(text.startsWith("word word")).toBe(true)
  })
})
