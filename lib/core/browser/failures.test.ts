import { describe, expect, it } from "vitest"

import { describeElement, failureReason } from "./failures"

// Playwright's failures as Chromium gave them (the call log dimmed with
// ANSI codes, as it comes), and the reason an answer gives for each.

const dim = (line: string) => `\u001b[2m${line}\u001b[22m`

function failure(first: string, log: string[]): Error {
  return new Error([first, "Call log:", ...log.map(dim)].join("\n"))
}

const COVERED = failure("locator.click: Timeout 10000ms exceeded.", [
  "  - waiting for locator('aria-ref=e2')",
  '    - locator resolved to <button id="a">Covered</button>',
  "  - attempting click action",
  "    2 × waiting for element to be visible, enabled and stable",
  "      - element is visible, enabled and stable",
  "      - scrolling into view if needed",
  "      - done scrolling",
  '      - <div id="cc" role="dialog" aria-label="Cookie consent">…</div> intercepts pointer events',
  "    - retrying click action",
  "      - waiting 500ms",
])

describe("why an action failed", () => {
  it("names what covers the element, by its role and label, and how to go on", () => {
    expect(failureReason(COVERED)).toBe(
      'Another element covers it and would get the click: a dialog (<div>) "Cookie consent" with id "cc". Close or move what covers it first (a dialog, a banner, a menu), or pass force: true to click anyway.',
    )
  })

  it("names the outer element when a part of one covers it", () => {
    const covered = failure("locator.click: Timeout 10000ms exceeded.", [
      '      - <span class="x">Accept everything we would like to know about you</span> from <div class="modal" aria-label="Privacy">…</div> subtree intercepts pointer events',
    ])
    expect(failureReason(covered)).toContain(
      'covers it and would get the click: a <div> element "Privacy".',
    )
    // The covering element's own text is not repeated.
    expect(failureReason(covered)).not.toContain("Accept everything")
  })

  it("says when it is hidden, disabled, moving or gone", () => {
    const with_ = (line: string) =>
      failureReason(
        failure("locator.click: Timeout 10000ms exceeded.", [
          '    - locator resolved to <button id="h">Hidden</button>',
          "    2 × waiting for element to be visible, enabled and stable",
          `      - ${line}`,
          "    - retrying click action",
          "      - waiting 500ms",
        ]),
      )

    expect(with_("element is not visible")).toMatch(
      /^The element is not visible/,
    )
    expect(with_("element is not enabled")).toMatch(/^The element is disabled/)
    expect(with_("element is not stable")).toMatch(/kept moving/)
    expect(with_("element was detached from the DOM, retrying")).toMatch(
      /left the page/,
    )
  })

  it("reads the reason Playwright puts first when the log has none", () => {
    expect(
      failureReason(
        failure(
          "locator.fill: Error: Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]",
          [
            "  - waiting for locator('#nt')",
            '    - locator resolved to <div id="nt">text</div>',
            "    - waiting for element to be visible, enabled and editable",
          ],
        ),
      ),
    ).toBe("The element does not take text.")
    expect(
      failureReason(
        failure(
          "locator.selectOption: Error: Element is not a <select> element",
          [],
        ),
      ),
    ).toBe("The element is not a list to choose in.")
  })

  it("tells an element that never appeared from one that did not finish", () => {
    expect(
      failureReason(
        failure("locator.click: Timeout 10000ms exceeded.", [
          "  - waiting for locator('aria-ref=e9')",
        ]),
      ),
    ).toBe(
      "The element was not on the page within 10 seconds. Take a new snapshot and use its refs.",
    )
    expect(
      failureReason(
        failure("locator.click: Timeout 10000ms exceeded.", [
          '    - locator resolved to <a href="/x">x</a>',
          "  - attempting click action",
        ]),
      ),
    ).toBe("It did not finish within 10 seconds.")
  })

  it("keeps anything else to Playwright's first line, bounded", () => {
    expect(
      failureReason(new Error(`page.goto: ${"x".repeat(1000)}\nmore`)),
    ).toHaveLength(301)
    expect(
      failureReason("Target page, context or browser has been closed"),
    ).toBe("The tab's page closed while this was being done.")
  })
})

describe("describing an element", () => {
  it("uses its tag, role, label and id, bounded", () => {
    expect(describeElement('<div class="overlay">…</div>')).toBe(
      "a <div> element",
    )
    expect(describeElement('<button title="Close" id="x">…</button>')).toBe(
      'a <button> element "Close" with id "x"',
    )
    expect(
      describeElement(`<div aria-label="${"y".repeat(500)}">`).length,
    ).toBeLessThanOrEqual(201)
  })
})
