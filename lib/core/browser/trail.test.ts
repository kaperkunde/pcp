import { describe, expect, it } from "vitest"

import { MAX_TRAIL_ENTRIES } from "./limits"
import { noteTrail, trailLines } from "./trail"

describe("a tab's trail", () => {
  it("keeps the latest few entries, with times and no more than a site", () => {
    const tab = { page: {} } as never

    for (let n = 0; n < MAX_TRAIL_ENTRIES + 5; n++) {
      noteTrail(
        tab,
        "navigated",
        "https://accounts.google.com/v3/signin?x=1",
        n,
      )
    }

    const lines = trailLines(tab, 10_000)

    expect(lines).toHaveLength(MAX_TRAIL_ENTRIES)
    expect(lines.join("\n")).toContain("navigated accounts.google.com")
    expect(lines.join("\n")).not.toContain("signin")
    expect(lines.join("\n")).not.toContain("x=1")
  })

  it("is empty for a tab with none", () => {
    expect(trailLines({ page: {} } as never)).toEqual([])
  })
})
