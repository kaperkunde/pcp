import { afterEach, describe, expect, it } from "vitest"

import { presentPageWith } from "./fetch"
import {
  REPEAT_FETCHES,
  REPEAT_WINDOW_MS,
  hardPageHint,
  hardPageReason,
  noteSiteFetch,
  resetSiteFetches,
  scriptBytes,
} from "./hard-page"

const article = `<html><body><h1>Annual report</h1>${"<p>A paragraph of ordinary words that a reader would want.</p>".repeat(20)}<a href="/report.pdf">Download the report</a></body></html>`
const shell = `<html><head><script>${"var a=1;".repeat(6_000)}</script></head><body><div id="root"></div></body></html>`
const withText = (markdown: string, pad = 0) =>
  `<html><body>${"<!-- -->".repeat(pad)}${markdown}</body></html>`

describe("hardPageReason", () => {
  it("leaves a page with its text and links alone", () => {
    const text = "# Annual report\n\n" + "Ordinary words. ".repeat(40)

    expect(hardPageReason(article, text)).toBeNull()
    expect(
      hardPageReason(
        article,
        `${text}\n[Download the report](https://x.example/r.pdf)`,
      ),
    ).toBeNull()
  })

  it("finds a script shell with next to no text", () => {
    expect(hardPageReason(shell, "")).toBe("near_empty")
    expect(hardPageReason(shell, "Loading...")).toBe("near_empty")
  })

  it("finds a page whose scripts outweigh a little text", () => {
    const text = "Words. ".repeat(60)

    expect(hardPageReason(shell, text)).toBe("script_heavy")
    // A small script is no sign.
    expect(
      hardPageReason(withText(text) + "<script>var a=1</script>", text),
    ).toBeNull()
  })

  it("finds download words with no link address", () => {
    const html = article
    const text = "Brochures\n\nDownload our brochure as a PDF.\n".repeat(8)

    expect(hardPageReason(html, text)).toBe("actions_without_links")
    expect(
      hardPageReason(html, `${text}\n[brochure](https://x.example/b.pdf)`),
    ).toBeNull()
  })

  it("does not mistake words inside others", () => {
    const text = "The pdfmaker and downloader pages. ".repeat(10)

    expect(hardPageReason(article, text)).toBeNull()
  })

  it("counts script bytes, not tags", () => {
    expect(
      scriptBytes("<script>abc</script><p>x</p><SCRIPT src=a>de</SCRIPT>"),
    ).toBe(5)
    expect(scriptBytes("<p>none</p>")).toBe(0)
  })
})

describe("presentPageWith", () => {
  const page = (text: string) => ({
    url: "https://spa.example/",
    status: "HTTP 200 OK",
    ok: true,
    type: "text/html",
    html: true,
    text,
    bytes: text.length,
    truncated: false,
  })

  it("says a script shell is hard, and a real page is not", () => {
    expect(presentPageWith(page(shell), {}).hard).toBe("near_empty")
    expect(presentPageWith(page(article), {}).hard).toBeNull()
  })
})

describe("noteSiteFetch", () => {
  afterEach(resetSiteFetches)

  it("is true from the third fetch of a site by a token within the window", () => {
    const at = 1_000_000
    const told = Array.from({ length: REPEAT_FETCHES }, (_, i) =>
      noteSiteFetch("t1", "a.example", at + i),
    )

    expect(told).toEqual([false, false, true])
    // Another token, another site, and too long ago, start again.
    expect(noteSiteFetch("t2", "a.example", at)).toBe(false)
    expect(noteSiteFetch("t1", "b.example", at)).toBe(false)
    expect(noteSiteFetch("t1", "a.example", at + REPEAT_WINDOW_MS + 10)).toBe(
      false,
    )
  })
})

describe("hardPageHint", () => {
  it("names the browser server", () => {
    expect(hardPageHint("browser")).toBe(
      "Hard to read this page? Open it with browser/navigate and read its snapshot (links show their /url).",
    )
  })
})
