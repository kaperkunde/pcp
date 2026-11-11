import { describe, expect, it } from "vitest"

import { checkCallArguments } from "./call-arguments"

// A tool's whole answer where a file or text goes: the arguments are refused
// as they always were, and the refusal says which handle inside the answer to
// pass instead (#88, get_attachment's answer given to save_file).

const ENVELOPE = {
  name: "plan.pdf",
  type: "application/pdf",
  size: 130_000,
  result: { $result: "abc123" },
}

describe("an answer given where a file goes", () => {
  it("is refused by a family's tool with the handle inside it named", async () => {
    const checked = await checkCallArguments(
      { kind: "storage" },
      "save_file",
      null,
      { path: "a.pdf", file: ENVELOPE },
    )

    expect(checked.fits).toBe(false)
    expect(!checked.fits && checked.hint).toContain(`/file/result`)
    expect(!checked.fits && checked.hint).toContain(`{"$result": "abc123"}`)
  })

  it("is refused by any other tool the same way", async () => {
    const checked = await checkCallArguments(
      { kind: "mcp" },
      "upload",
      JSON.stringify({
        type: "object",
        properties: { data: { type: "string" } },
      }),
      { data: ENVELOPE },
    )

    expect(checked.fits).toBe(false)
    expect(!checked.fits && checked.hint).toContain(`/data/result`)
  })

  it("adds nothing where there is no single handle inside", async () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { data: { type: "string" } },
    })

    for (const data of [
      { name: "x" },
      { a: { result: { $result: "one" } }, b: { result: { $result: "two" } } },
    ]) {
      const checked = await checkCallArguments(
        { kind: "mcp" },
        "upload",
        schema,
        {
          data,
        },
      )

      expect(checked.fits).toBe(false)
      expect(!checked.fits && checked.hint).toBeUndefined()
    }
  })

  it("adds nothing when the failure is elsewhere and the answer sits where an object goes", async () => {
    const checked = await checkCallArguments(
      { kind: "mcp" },
      "upload",
      JSON.stringify({
        type: "object",
        properties: { data: { type: "object" }, n: { type: "number" } },
      }),
      { data: ENVELOPE, n: "x" },
    )

    expect(checked.fits).toBe(false)
    expect(!checked.fits && checked.hint).toBeUndefined()
  })

  it("names the answer when a problem is under it, and once", async () => {
    const checked = await checkCallArguments(
      { kind: "storage" },
      "save_file",
      null,
      { path: "a.pdf", file: ENVELOPE },
    )

    expect(!checked.fits && checked.hint?.match(/whole answer/g)).toHaveLength(
      1,
    )
  })
})
