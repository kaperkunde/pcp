import { describe, expect, it } from "vitest"

import {
  compare,
  flatten,
  formatTable,
  summariseInput,
  tellFor,
} from "./diff.mjs"

/** A fingerprint as harness.html writes one, cut to what the test needs. */
function fingerprint(overrides: Record<string, unknown> = {}) {
  return {
    meta: { harness: 1, label: "pcp", takenAt: "2026-10-22T10:00:00Z" },
    navigator: {
      webdriver: false,
      userAgent: "Mozilla/5.0 Chrome/153.0.0.0",
      languages: ["en-US", "en"],
      hardwareConcurrency: 8,
    },
    window: { frame: [0, 85], screenX: 10 },
    webgl: { unmaskedRenderer: "ANGLE (Apple M2)" },
    canvas: { hash: "aaa" },
    fonts: { present: ["Arial", "Menlo"] },
    flags: [],
    ...overrides,
  }
}

describe("flattening a fingerprint", () => {
  it("keeps lists of values whole and indexes lists of objects", () => {
    expect(
      flatten({
        a: { b: 1, list: ["x", "y"] },
        objects: [{ c: 2 }],
        empty: {},
      }),
    ).toEqual({
      "a.b": 1,
      "a.list": ["x", "y"],
      "objects.0.c": 2,
      empty: {},
    })
  })
})

describe("the input, summarised", () => {
  it("counts clicks by what gave them away and the spread of key gaps", () => {
    expect(
      summariseInput({
        mouseMoves: 1,
        clicks: [
          { trusted: true, screenMinusClient: [0, 0], moveBeforeMs: 1 },
          { trusted: false, screenMinusClient: [8, 85], moveBeforeMs: null },
        ],
        keyIntervalsMs: [30, 30, 30],
      }),
    ).toEqual({
      mouseMoves: 1,
      clicks: 2,
      clicksAtPagePosition: 1,
      clicksUntrusted: 1,
      clicksWithoutMoveFirst: 1,
      keyIntervalSpreadMs: 0,
    })
  })
})

describe("comparing two fingerprints", () => {
  it("lists only what differs, the known tells first", () => {
    const pcp = fingerprint({
      navigator: {
        webdriver: false,
        userAgent: "Mozilla/5.0 HeadlessChrome/153.0.0.0",
        languages: ["en-US", "en"],
        hardwareConcurrency: 4,
      },
      webgl: { unmaskedRenderer: "ANGLE (Google, SwiftShader)" },
      canvas: { hash: "bbb" },
      meta: { harness: 1, label: "pcp", takenAt: "2026-10-22T11:00:00Z" },
    })
    const person = fingerprint({
      meta: { harness: 1, label: "claude-app", takenAt: "x" },
    })

    const rows = compare(pcp, person)

    expect(rows.map((row) => row.path)).toEqual([
      "navigator.userAgent",
      "webgl.unmaskedRenderer",
      "canvas.hash",
      "navigator.hardwareConcurrency",
    ])
    expect(rows.every((row) => row.differs)).toBe(true)
    // When it was taken says nothing about the browser.
    expect(rows.some((row) => row.path.startsWith("meta."))).toBe(false)
  })

  it("puts a difference the first browser's own page flagged above an equal one", () => {
    const pcp = fingerprint({
      window: { frame: [0, 0], screenX: 0 },
      flags: [{ path: "window.frame", why: "the window is exactly the page" }],
    })
    const rows = compare(pcp, fingerprint())

    expect(rows[0]).toMatchObject({
      path: "window.frame",
      flaggedA: true,
      flaggedB: false,
    })
    expect(rows[0]!.weight).toBe(tellFor("window.frame").weight)
  })

  it("includes the values that are the same when asked, below every difference", () => {
    const rows = compare(
      fingerprint({ canvas: { hash: "ccc" } }),
      fingerprint(),
      {
        all: true,
      },
    )

    expect(rows[0]).toMatchObject({ path: "canvas.hash", differs: true })
    expect(rows.slice(1).every((row) => !row.differs)).toBe(true)
    expect(rows.map((row) => row.path)).toContain("navigator.webdriver")
  })

  it("weighs automation above a difference any two machines have", () => {
    expect(tellFor("automation.runtimeEnableDetected").weight).toBeGreaterThan(
      tellFor("canvas.hash").weight,
    )
    expect(tellFor("navigator.webdriver").weight).toBe(100)
    expect(tellFor("something.new")).toEqual({ weight: 10, note: "" })
  })
})

describe("the table", () => {
  it("prints markdown with both labels, escaping what would break a cell", () => {
    const rows = compare(
      fingerprint({ fonts: { present: ["A|B"] } }),
      fingerprint(),
    )
    const table = formatTable(rows, ["pcp", "claude-app"], { markdown: true })
    const lines = table.split("\n")

    expect(lines[0]).toBe(
      "| # | tell | path | pcp | claude-app | why it matters |",
    )
    expect(lines[2]).toContain("fonts.present")
    expect(lines[2]).toContain('["A\\|B"]')
  })
})
