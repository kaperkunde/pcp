import { describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { callBrowserTool } from "./call"
import { MAX_TARGET_CANDIDATES } from "./limits"
import { runningBrowser } from "./runtime"
import { parseSnapshot } from "./snapshot"
import { nameMatches, targetRefusal } from "./target"

// What a target that is not one element is refused with, and a call that
// names no tab, without a browser: the page is a snapshot here, and the
// count what Playwright's getByRole would have found.

const PAGE = parseSnapshot(`- generic [ref=e1]:
  - navigation "Conversations" [ref=e2]:
    - button "Reply" [ref=e3]
  - main [ref=e4]:
    - button "Reply" [ref=e5]
    - button "Reply all" [ref=e6]
    - button "Send" [disabled] [ref=e7]`)

describe("a target that is not one element", () => {
  it("lists the elements of its role when none matches", () => {
    const refusal = targetRefusal(PAGE, { role: "button", name: "Delete" }, 0)!

    expect(refusal.split("\n")[0]).toBe(
      'There is no button named "Delete" on the page. The button elements it has (give one\'s name, or its ref):',
    )
    expect(refusal).toContain(
      '{"role":"button","name":"Send","ref":"e7","states":{"disabled":true},"landmark":{"role":"main","ref":"e4"}}',
    )
    expect(targetRefusal(PAGE, { role: "link", name: "Home" }, 0)).toBe(
      'There is no link named "Home" on the page, and no link at all. Take a snapshot to see the page\'s elements and their roles.',
    )
  })

  it("lists the ones that match when several do, with where each is", () => {
    const refusal = targetRefusal(PAGE, { role: "button", name: "reply" }, 3)!

    expect(refusal.split("\n")[0]).toBe(
      '3 elements match button named "reply". Say which: nth (0 for the first, in page order), exact: true for the whole name, within (the ref of the part of the page it is in), or its ref.',
    )
    expect(
      refusal
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line).ref),
    ).toEqual(["e3", "e5", "e6"])
    expect(refusal).toContain(
      '"landmark":{"role":"navigation","name":"Conversations","ref":"e2"}',
    )
  })

  it("refuses an nth past the last, and passes one element", () => {
    expect(
      targetRefusal(PAGE, { role: "button", name: "Reply", nth: 2 }, 2),
    ).toBe(
      'Only 2 elements match button named "Reply", so there is no nth 2 (nth counts from 0).',
    )
    expect(targetRefusal(PAGE, { role: "button", name: "Send" }, 1)).toBeNull()
    expect(
      targetRefusal(PAGE, { role: "button", name: "Reply", nth: 1 }, 2),
    ).toBeNull()
  })

  it("lists at most MAX_TARGET_CANDIDATES, and says how many more", () => {
    const many = parseSnapshot(
      Array.from(
        { length: MAX_TARGET_CANDIDATES + 4 },
        (_, i) => `- button "Like ${i}" [ref=e${i + 1}]`,
      ).join("\n"),
    )
    const refusal = targetRefusal(many, { role: "button", name: "Like" }, 14)!
    const lines = refusal.split("\n")

    expect(lines).toHaveLength(1 + MAX_TARGET_CANDIDATES + 1)
    expect(lines.at(-1)).toBe("… and 4 more")
  })

  it("matches names as getByRole does: a part, case aside, unless exact", () => {
    expect(nameMatches("Reply all", "reply")).toBe(true)
    expect(nameMatches("Reply  all", "reply all")).toBe(true)
    expect(nameMatches("Reply all", "Reply", true)).toBe(false)
    expect(nameMatches(" Reply ", "Reply", true)).toBe(true)
    expect(nameMatches(null, "Reply")).toBe(false)
  })
})

describe("a call that names no tab", () => {
  it("is refused as a tool error before the browser is touched, saying how to open one", async () => {
    const ctx = { vaultId: "no-such-vault" } as VaultContext

    for (const [name, args] of [
      ["snapshot", {}],
      ["click", { ref: "e1" }],
      ["navigate", { url: "https://example.com" }],
      ["tabs", { action: "reset" }],
    ] as const) {
      const refused = await callBrowserTool(
        ctx,
        { id: "browser", name: "Browser" },
        name,
        args,
        { tokenId: "t", publicUrl: "http://pcp.test" },
      )
      const text = (refused.content[0] as { text: string }).text

      expect(refused.isError, name).toBe(true)
      expect(text, name).toBe(
        `${name} needs the tab to act on (tab), and the browser never picks one. This token has no tab open. Open one with tabs (action open, with the url): its answer names the new tab's id, which every other browser tool takes as tab.`,
      )
    }

    expect(runningBrowser("no-such-vault")).toBeNull()
  })
})
