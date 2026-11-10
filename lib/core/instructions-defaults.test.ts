import { describe, expect, it } from "vitest"

import { checkInstructions } from "./instructions"
import { mergeLines } from "./line-merge"
import {
  currentTemplate,
  INSTRUCTION_TEMPLATES,
  templateText,
} from "./instructions-defaults"

describe("PCP's suggested instructions", () => {
  it("keep every version, oldest first, the last one current", () => {
    const versions = INSTRUCTION_TEMPLATES.map((template) => template.version)

    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(currentTemplate().version).toBe(versions.at(-1))
    expect(templateText(versions[0]!)).toBe(INSTRUCTION_TEMPLATES[0]!.text)
    expect(templateText(0)).toBeNull()
  })

  it("are short, and pass the owner's own check", () => {
    for (const template of INSTRUCTION_TEMPLATES) {
      expect(template.text.length).toBeLessThanOrEqual(1_200)
      expect(checkInstructions(template.text)).toBe(template.text)
    }

    const text = currentTemplate().text
    for (const word of [
      "describe",
      "search",
      "skill",
      "call_handle",
      "check_permission",
      "link",
      "memory",
      "run_read",
      "execute_read",
      "execute_write",
      "execute_destructive",
    ]) {
      expect(text).toContain(word)
    }
  })

  it("ask for PCP's links as markdown links from version 3, offered as a merge", () => {
    const v2 = templateText(2)!
    const v3 = templateText(3)!

    // Versions 1 and 2 stay as they were.
    expect(v2).toContain(
      "- When an answer gives you a link to PCP, end your reply with it, on a line of its own.",
    )
    expect(v3).toMatch(/markdown link with a short label/)
    expect(v3).toContain("never the bare address")

    // A token that kept version 2 as it was takes version 3 whole.
    expect(mergeLines(v2, v2, v3)).toEqual({ text: v3, conflicts: 0 })

    // One that changed another line keeps it, and gets the new link line.
    const mine = `${v2}\n- Answer in Dutch.`
    const merged = mergeLines(v2, mine, v3)
    expect(merged.conflicts).toBe(0)
    expect(merged.text).toBe(`${v3}\n- Answer in Dutch.`)
  })

  it("name the entry tools per tier from version 4, offered as a merge", () => {
    const v3 = templateText(3)!
    const v4 = templateText(4)!

    expect(v3).toContain("call_tool, run_code")
    expect(v4).not.toContain("call_tool, run_code")
    expect(v4).toContain("execute_destructive")
    expect(mergeLines(v3, v3, v4)).toEqual({ text: v4, conflicts: 0 })
  })

  it("check on the owner's next message from version 5, offered as a merge", () => {
    const v4 = templateText(4)!
    const v5 = templateText(5)!

    expect(v4).not.toContain("next message")
    expect(v5).toContain(
      "On the owner's next message after such a link, whatever it says, call check_permission with its id",
    )
    expect(mergeLines(v4, v4, v5)).toEqual({ text: v5, conflicts: 0 })

    const mine = `${v4}\n- Answer in Dutch.`
    expect(mergeLines(v4, mine, v5)).toEqual({
      text: `${v5}\n- Answer in Dutch.`,
      conflicts: 0,
    })
  })

  it("let several links close one reply from version 6, offered as a merge", () => {
    const v5 = templateText(5)!
    const v6 = templateText(6)!

    // Version 5 stays as it was: one link, last.
    expect(v5).toContain(
      "- When an answer gives you a link to PCP, end your reply with it as a markdown link",
    )
    expect(v6).toContain(
      "- When answers give you links to PCP, end your reply with all of them, each a markdown link with a short label",
    )
    expect(v6).toContain("never the bare address")
    // Only that line changed.
    const changed = v6
      .split("\n")
      .filter((line) => !v5.split("\n").includes(line))
    expect(changed).toHaveLength(1)
    expect(mergeLines(v5, v5, v6)).toEqual({ text: v6, conflicts: 0 })

    const mine = `${v5}\n- Answer in Dutch.`
    expect(mergeLines(v5, mine, v6)).toEqual({
      text: `${v6}\n- Answer in Dutch.`,
      conflicts: 0,
    })
  })
})
