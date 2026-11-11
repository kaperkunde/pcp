import type { CDPSession } from "patchright-core"
import { describe, expect, it } from "vitest"

import { tabOwnsFrame, type Downloads } from "./downloads"

// Whose a frame is, for a download call: the tab's own frames, and the
// windows it opened, followed back through their openers as Chromium named
// them, even once they closed; never through another token's tab.

/** A browser whose openers are known, and which knows no target now. */
function downloadsWith(openers: Record<string, string>): Downloads {
  return {
    openers: new Map(Object.entries(openers)),
    session: {
      send: () => Promise.reject(new Error("No target with given id found")),
    },
  } as unknown as Downloads
}

const TAB = {
  mainFrameId: "A",
  cdp: {
    send: async () => ({ frameTree: { frame: { id: "A" } } }),
  } as unknown as CDPSession,
}

const owns = tabOwnsFrame

describe("a frame a download call takes", () => {
  it("is the tab's, or a window it opened, however many openers back and once closed", async () => {
    const downloads = downloadsWith({ P: "A", W: "P" })
    expect(await owns(downloads, TAB, "A")).toBe(true)
    expect(await owns(downloads, TAB, "P")).toBe(true)
    expect(await owns(downloads, TAB, "W")).toBe(true)
    expect(await owns(downloads, TAB, "X")).toBe(false)
  })

  it("is never a window another token's tab opened, though the tab opened that one", async () => {
    // P is a popup of the tab that the owner handed to another token.
    const downloads = downloadsWith({ P: "A", W: "P" })
    const others = (targetId: string) => targetId === "P"
    expect(await owns(downloads, TAB, "W", others)).toBe(false)
    expect(await owns(downloads, TAB, "P", others)).toBe(false)
  })
})
