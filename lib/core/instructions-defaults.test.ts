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
      "run_code",
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
})
