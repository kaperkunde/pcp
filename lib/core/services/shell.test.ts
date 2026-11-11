import { spawnSync } from "node:child_process"

import { describe, expect, it } from "vitest"

import { commandLine, shellQuote, shScript } from "./shell"

// Quoting against a real sh: whatever a word holds, sh hands it to the
// program as it is, and nothing in it runs.

/** The words sh hands a program for this command line. */
function wordsOf(line: string): string[] {
  const result = spawnSync("/bin/sh", [
    "-c",
    `set -- ${line}; for word in "$@"; do printf '%s\\0' "$word"; done`,
  ])
  return result.stdout.toString("utf8").split("\0").slice(0, -1)
}

const HOSTILE = [
  "plain",
  "with space",
  "it's",
  "'",
  "''",
  "$(touch /tmp/pcp-pwned)",
  "`id`",
  "$HOME",
  "a;b",
  "a && b",
  "a|b",
  "*",
  "~",
  "-rf",
  "line\nbreak",
  "back\\slash",
  '"double"',
  "!",
  "=",
  "FOO=bar",
  "",
  "ünïcödé",
]

describe("shellQuote", () => {
  it("hands every word to the program as it is", () => {
    expect(wordsOf(commandLine(HOSTILE))).toEqual(HOSTILE)
  })

  it("leaves plain words bare and quotes the rest", () => {
    expect(shellQuote("docker")).toBe("docker")
    expect(shellQuote("pcp.service=abc")).toBe("'pcp.service=abc'")
    expect(shellQuote("0.0.0.0:8080:80")).toBe("0.0.0.0:8080:80")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("")).toBe("''")
  })

  it("refuses a NUL, which no argument can carry", () => {
    expect(() => shellQuote("a\0b")).toThrow(/NUL/)
  })

  it("runs a whole script as one word of sh -c", () => {
    const script = `printf '%s' ${shellQuote("$(echo no)'; echo yes")}`
    const result = spawnSync("/bin/sh", ["-c", shScript(script)])
    expect(result.stdout.toString()).toBe("$(echo no)'; echo yes")
  })
})
