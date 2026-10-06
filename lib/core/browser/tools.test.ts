import { describe, expect, it } from "vitest"

import { browserTools, browserToolSpec, parseBrowserArgs } from "./tools"

// The browser's fixed catalogue: what an assistant finds, and arguments
// refused before the browser is touched.

describe("the browser's tools", () => {
  it("are the same set for every vault, with schemas and annotations", () => {
    const tools = browserTools()

    expect(tools.map((tool) => tool.name)).toEqual([
      "tabs",
      "navigate",
      "back",
      "snapshot",
      "read_page",
      "find",
      "click",
      "type",
      "press_key",
      "select_option",
      "scroll",
      "wait_for",
      "screenshot",
      "handle_dialog",
      "hand_over",
    ])

    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" })
      expect(tool.description).toBeTruthy()
    }

    const readOnly = tools
      .filter(
        (tool) => (tool.annotations as { readOnlyHint: boolean }).readOnlyHint,
      )
      .map((tool) => tool.name)
    expect(readOnly).toEqual([
      "snapshot",
      "read_page",
      "find",
      "scroll",
      "wait_for",
      "screenshot",
    ])

    // What the owner's permission page warns about: acting on a site, not
    // opening one.
    const destructive = tools
      .filter(
        (tool) =>
          (tool.annotations as { destructiveHint?: boolean }).destructiveHint,
      )
      .map((tool) => tool.name)
    expect(destructive).toEqual([
      "click",
      "type",
      "press_key",
      "select_option",
      "handle_dialog",
    ])
  })

  it("offer nothing that runs code or reads the sign-ins", () => {
    const names = browserTools()
      .map((tool) => tool.name)
      .join(" ")
    expect(names).not.toMatch(/evaluate|script|cookie|storage|download/)
  })

  it("check their arguments", () => {
    const parse = (name: string, args: unknown) =>
      parseBrowserArgs(browserToolSpec(name)!, args)

    expect(parse("navigate", { url: "https://example.com" })).toEqual({
      url: "https://example.com",
    })
    expect(() => parse("navigate", {})).toThrow(/navigate:/)
    expect(() => parse("click", { ref: "button" })).toThrow(
      /ref looks like e12/,
    )
    expect(() => parse("tabs", { action: "open" })).toThrow(/open needs a url/)
    expect(() => parse("tabs", { action: "close" })).toThrow(
      /need the tab's id/,
    )
    expect(() => parse("scroll", { direction: "down", ref: "e1" })).toThrow(
      /one of them/,
    )
    expect(() => parse("wait_for", {})).toThrow(/one of them/)
    expect(() => parse("snapshot", { tab: "x", extra: 1 })).toThrow()
    expect(() => parse("hand_over", { message: "x".repeat(1001) })).toThrow()
  })
})
