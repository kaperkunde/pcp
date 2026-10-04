import { describe, expect, it } from "vitest"

import { decodeBody, htmlToMarkdown, looksLikeHtml, sliceText } from "./html"

// What web_fetch makes of a page before an assistant reads it.

describe("HTML as Markdown", () => {
  it("keeps the words and structure, drops what runs or styles", () => {
    const { title, markdown } = htmlToMarkdown(
      `<!doctype html><html><head><title> The  Guide </title>
      <style>body { color: red }</style><script>alert("hi")</script></head>
      <body><h1>Welcome</h1><p>Read <a href="/docs/start">the docs</a>
      or <a href="javascript:alert(1)">this</a>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <pre><code>npm install</code></pre>
      <img src="logo.png" alt="Logo"><img src="data:image/png;base64,AAAA" alt="Inline chart">
      <a href="/icon"></a><iframe src="https://ads.example/"></iframe>
      <noscript>Enable JavaScript</noscript></body></html>`,
      "https://example.com/guide/",
    )

    expect(title).toBe("The Guide")
    expect(markdown).toContain("# Welcome")
    expect(markdown).toContain("[the docs](https://example.com/docs/start)")
    // A javascript: link keeps its words and loses its target.
    expect(markdown).toContain("or this.")
    expect(markdown).not.toContain("javascript:")
    expect(markdown).toMatch(/-\s+One\n-\s+Two/)
    expect(markdown).toContain("```\nnpm install\n```")
    expect(markdown).toContain("![Logo](https://example.com/guide/logo.png)")
    expect(markdown).toContain("Inline chart")
    expect(markdown).not.toContain("data:image")
    expect(markdown).not.toContain("alert")
    expect(markdown).not.toContain("color: red")
    expect(markdown).not.toContain("Enable JavaScript")
    expect(markdown).not.toContain("ads.example")
    expect(markdown).not.toContain("](https://example.com/icon)")
  })

  it("tells an unlabelled page that is HTML from one that is not", () => {
    expect(looksLikeHtml(Buffer.from("  <!DOCTYPE html><p>x"))).toBe(true)
    expect(looksLikeHtml(Buffer.from("<html lang=en>"))).toBe(true)
    expect(looksLikeHtml(Buffer.from('{"html": true}'))).toBe(false)
  })
})

describe("decoding", () => {
  it("follows the declared charset, then a meta charset, then UTF-8", () => {
    const latin1 = Buffer.from("café", "latin1")

    expect(decodeBody(latin1, "text/plain; charset=ISO-8859-1", false)).toBe(
      "café",
    )
    expect(
      decodeBody(
        Buffer.concat([
          Buffer.from('<meta charset="windows-1252"><p>'),
          latin1,
        ]),
        "text/html",
        true,
      ),
    ).toContain("café")
    expect(decodeBody(Buffer.from("café"), "text/plain", false)).toBe("café")
    // A charset nobody knows falls back to UTF-8.
    expect(
      decodeBody(Buffer.from("café"), "text/plain; charset=nope", false),
    ).toBe("café")
  })
})

describe("reading in parts", () => {
  it("cuts at the length asked, never between the halves of a pair", () => {
    expect(sliceText("abcdef", 0, 4)).toEqual({
      part: "abcd",
      start: 0,
      end: 4,
      total: 6,
    })
    expect(sliceText("abcdef", 4, 4)).toMatchObject({ part: "ef", end: 6 })
    expect(sliceText("ab😀cd", 0, 3)).toMatchObject({ part: "ab", end: 2 })
    expect(sliceText("abc", 10, 4)).toMatchObject({ part: "", start: 3 })
  })
})
