import { describe, expect, it } from "vitest"

import { faviconDataUrl } from "./favicon"
import { MAX_FAVICON_BYTES } from "./limits"

// A tab's icon, from the bytes Chromium loaded for the page: shown as a
// data: address only when it is a picture of a size PCP keeps.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

describe("a tab's icon", () => {
  it("is a data: address of the picture the page served", () => {
    expect(faviconDataUrl("image/png", PNG.toString("base64"), true)).toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    )
    // The type as the server wrote it, parameters and case aside.
    expect(
      faviconDataUrl(
        "Image/X-Icon; charset=binary",
        PNG.toString("base64"),
        true,
      ),
    ).toMatch(/^data:image\/x-icon;base64,/)
    // An SVG comes as text.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    expect(faviconDataUrl("image/svg+xml", svg, false)).toBe(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    )
  })

  it("is none for what is not a picture, is empty or is too large", () => {
    expect(faviconDataUrl("text/html", "<h1>hi</h1>", false)).toBeNull()
    expect(faviconDataUrl("application/octet-stream", "AAAA", true)).toBeNull()
    expect(faviconDataUrl("image/png", "", true)).toBeNull()

    const largest = Buffer.alloc(MAX_FAVICON_BYTES, 1).toString("base64")
    const over = Buffer.alloc(MAX_FAVICON_BYTES + 1, 1).toString("base64")
    expect(faviconDataUrl("image/png", largest, true)).not.toBeNull()
    expect(faviconDataUrl("image/png", over, true)).toBeNull()
  })
})
