import { afterEach, describe, expect, it } from "vitest"

import {
  clearMailDiagnostics,
  mailDiagnostics,
  recordMailCall,
  scrubNotice,
} from "./diagnostics"

afterEach(() => clearMailDiagnostics())

describe("mail diagnostics", () => {
  it("keeps the newest calls of an account, a few", () => {
    for (let n = 0; n < 40; n++) {
      recordMailCall("server-1", {
        tool: `tool-${n}`,
        phases: { connect: n },
        notices: [],
        reused: false,
        outcome: "ok",
      })
    }

    const kept = mailDiagnostics("server-1")
    expect(kept.length).toBeLessThanOrEqual(20)
    expect(kept[0]).toMatchObject({ tool: "tool-39", phases: { connect: 39 } })
    expect(mailDiagnostics("server-2")).toEqual([])
  })

  it("keeps only so many accounts", () => {
    for (let n = 0; n < 200; n++) {
      recordMailCall(`server-${n}`, {
        phases: {},
        notices: [],
        reused: false,
        outcome: "ok",
      })
    }

    expect(mailDiagnostics("server-0")).toEqual([])
    expect(mailDiagnostics("server-199")).toHaveLength(1)
  })

  it("scrubs a server's text of addresses and credentials, and bounds it", () => {
    const text = scrubNotice(
      "* BYE [ALERT] Too many connections for ada@example.com from 203.0.113.9 at imap.example.com, see https://support.example.com/x token=abc123secret " +
        "x".repeat(500),
      ["abc123secret"],
    )

    expect(text).not.toMatch(
      /ada@example|203\.0\.113|imap\.example|support\.example|abc123secret/,
    )
    expect(text).toMatch(/ALERT/)
    expect(text).toMatch(/Too many connections/)
    expect(text.length).toBeLessThanOrEqual(200)
  })

  it("bounds the notices of one call", () => {
    recordMailCall("server-1", {
      phases: {},
      notices: Array.from({ length: 50 }, (_, n) => `* OK [ALERT] n${n}`),
      reused: true,
      outcome: "ok",
    })

    expect(mailDiagnostics("server-1")[0]!.notices.length).toBeLessThanOrEqual(
      10,
    )
  })
})
