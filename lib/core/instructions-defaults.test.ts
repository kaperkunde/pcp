import { describe, expect, it } from "vitest"

import { checkInstructions } from "./instructions"
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
      "describe_tool",
      "call_handle",
      "check_permission",
      "link",
      "memory",
      "run_code",
    ]) {
      expect(text).toContain(word)
    }
  })
})
