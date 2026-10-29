import { describe, expect, it } from "vitest"

import {
  BROWSER_ARG_ALIASES,
  browserTools,
  browserToolSpec,
  parseBrowserArgs,
} from "./tools"

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
      "upload_file",
      "scroll",
      "wait_for",
      "screenshot",
      "download",
      "handle_dialog",
      "hand_over",
      "request_secret",
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
      "upload_file",
      "download",
      "handle_dialog",
    ])
  })

  it("offer nothing that runs code or reads the sign-ins", () => {
    const names = browserTools()
      .map((tool) => tool.name)
      .join(" ")
    expect(names).not.toMatch(/evaluate|script|cookie|storage/)
  })

  it("take a secret only as type's text, by its name", () => {
    const parse = (name: string, args: unknown) =>
      parseBrowserArgs(browserToolSpec(name)!, args)

    expect(
      parse("type", { tab: "t1", ref: "e3", text: { $secret: "Shop" } }),
    ).toEqual({ tab: "t1", ref: "e3", text: { $secret: "Shop" } })
    expect(() =>
      parse("type", {
        tab: "t1",
        ref: "e3",
        text: { $secret: "Shop", template: "x {{secret}}" },
      }),
    ).toThrow()
    expect(() =>
      parse("type", { tab: "t1", ref: "e3", text: { $secret: "" } }),
    ).toThrow()
    expect(() =>
      parse("press_key", { tab: "t1", key: { $secret: "Shop" } }),
    ).toThrow()
    expect(() =>
      parse("select_option", {
        tab: "t1",
        ref: "e3",
        values: [{ $secret: "Shop" }],
      }),
    ).toThrow()
    expect(() =>
      parse("handle_dialog", {
        tab: "t1",
        action: "accept",
        text: { $secret: "Shop" },
      }),
    ).toThrow()
  })

  it("ask for a secret by its name, purpose, sites and kind", () => {
    const parse = (args: unknown) =>
      parseBrowserArgs(browserToolSpec("request_secret")!, args)
    const ask = {
      name: "Shop password",
      purpose: "To sign in to the shop.",
      origins: ["https://shop.example"],
    }

    expect(parse(ask)).toEqual(ask)
    expect(parse({ ...ask, kind: "totp" })).toEqual({ ...ask, kind: "totp" })
    expect(() => parse({ ...ask, kind: "hotp" })).toThrow()
    expect(() => parse({ ...ask, name: "" })).toThrow()
    expect(() => parse({ ...ask, name: "x".repeat(101) })).toThrow()
    expect(() => parse({ ...ask, purpose: "" })).toThrow()
    expect(() => parse({ ...ask, purpose: "x".repeat(501) })).toThrow()
    expect(() => parse({ ...ask, origins: [] })).toThrow()
    expect(() =>
      parse({
        ...ask,
        origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`),
      }),
    ).toThrow()
    // No value: the owner types it in on PCP's page.
    expect(() => parse({ ...ask, value: "hunter2" })).toThrow()
  })

  it("move files only as kept results, never by a path", () => {
    const parse = (name: string, args: unknown) =>
      parseBrowserArgs(browserToolSpec(name)!, args)

    expect(
      parse("upload_file", {
        tab: "t1",
        ref: "e3",
        files: [
          { $result: "r1" },
          { $result: "r2", name: "a.pdf", type: "application/pdf" },
        ],
      }),
    ).toEqual({
      tab: "t1",
      ref: "e3",
      files: [
        { $result: "r1" },
        { $result: "r2", name: "a.pdf", type: "application/pdf" },
      ],
    })
    expect(() =>
      parse("upload_file", { tab: "t1", ref: "e3", files: [] }),
    ).toThrow()
    expect(() =>
      parse("upload_file", { tab: "t1", ref: "e3", files: ["/etc/passwd"] }),
    ).toThrow()
    expect(() =>
      parse("upload_file", {
        tab: "t1",
        ref: "e3",
        files: [{ path: "/etc/passwd" }],
      }),
    ).toThrow()
    expect(() =>
      parse("upload_file", {
        tab: "t1",
        ref: "e3",
        files: [{ $result: "r1", name: "../../etc/passwd" }],
      }),
    ).toThrow(/without a path/)
    expect(() =>
      parse("upload_file", {
        tab: "t1",
        ref: "e3",
        files: Array.from({ length: 21 }, () => ({ $result: "r1" })),
      }),
    ).toThrow()

    expect(parse("download", { tab: "t1", ref: "e4" })).toEqual({
      tab: "t1",
      ref: "e4",
    })
    expect(
      parse("download", { tab: "t1", url: "https://example.com/a.pdf" }),
    ).toEqual({ tab: "t1", url: "https://example.com/a.pdf" })
    expect(() => parse("download", { tab: "t1" })).toThrow(/one of them/)
    expect(() =>
      parse("download", {
        tab: "t1",
        ref: "e4",
        url: "https://example.com/a.pdf",
      }),
    ).toThrow(/one of them/)
    expect(() =>
      parse("download", { tab: "t1", ref: "e4", path: "/tmp/x" }),
    ).toThrow()
  })

  it("check their arguments", () => {
    const parse = (name: string, args: unknown) =>
      parseBrowserArgs(browserToolSpec(name)!, args)

    expect(
      parse("navigate", { tab: "t1", url: "https://example.com" }),
    ).toEqual({ tab: "t1", url: "https://example.com" })
    expect(() => parse("navigate", { tab: "t1" })).toThrow(/navigate:/)
    expect(() => parse("click", { tab: "t1", ref: "button" })).toThrow(
      /ref looks like e12/,
    )
    expect(() => parse("tabs", { action: "open" })).toThrow(/open needs a url/)
    expect(() => parse("tabs", { action: "close" })).toThrow(
      /need the tab's id/,
    )
    expect(() => parse("tabs", { action: "reset" })).toThrow(
      /need the tab's id/,
    )
    expect(() => parse("tabs", { action: "select", tab: "t1" })).toThrow()
    expect(() =>
      parse("scroll", { tab: "t1", direction: "down", ref: "e1" }),
    ).toThrow(/one of them/)
    expect(() => parse("wait_for", { tab: "t1" })).toThrow(/one of them/)
    expect(() => parse("snapshot", { tab: "x", extra: 1 })).toThrow()
    expect(() =>
      parse("hand_over", { tab: "t1", message: "x".repeat(1001) }),
    ).toThrow()
    expect(
      parse("screenshot", { tab: "t1", max_width: 640, quality: 50 }),
    ).toEqual({ tab: "t1", max_width: 640, quality: 50 })
    expect(() => parse("screenshot", { tab: "t1", max_width: 5000 })).toThrow()
    expect(() => parse("screenshot", { tab: "t1", quality: 100 })).toThrow()
    expect(parse("find", { tab: "t1", text: "Reply", within: "e12" })).toEqual({
      tab: "t1",
      text: "Reply",
      within: "e12",
    })
    expect(() =>
      parse("read_page", { tab: "t1", ref: "e2", main_only: true }),
    ).toThrow(/at most one/)
  })

  it("name the tab in every tool but tabs' open and list, and request_secret", () => {
    for (const tool of browserTools()) {
      const schema = tool.inputSchema as { required?: string[] }
      expect(schema.required?.includes("tab") ?? false, tool.name).toBe(
        tool.name !== "tabs" && tool.name !== "request_secret",
      )
    }
    expect(
      parseBrowserArgs(browserToolSpec("tabs")!, {
        action: "open",
        url: "https://example.com",
      }),
    ).toEqual({ action: "open", url: "https://example.com" })
  })

  it("take a target, by role and name, in place of a ref", () => {
    const parse = (name: string, args: unknown) =>
      parseBrowserArgs(browserToolSpec(name)!, args)
    const target = {
      role: "button",
      name: "Send",
      exact: true,
      nth: 1,
      within: "e4",
    }

    for (const name of [
      "click",
      "type",
      "select_option",
      "upload_file",
      "scroll",
      "screenshot",
      "read_page",
    ]) {
      const extra =
        name === "type"
          ? { text: "x" }
          : name === "select_option"
            ? { values: ["a"] }
            : name === "upload_file"
              ? { files: [{ $result: "r1" }] }
              : {}
      expect(parse(name, { tab: "t1", target, ...extra }), name).toMatchObject({
        target,
      })
      expect(
        () => parse(name, { tab: "t1", ref: "e1", target, ...extra }),
        name,
      ).toThrow()
    }

    expect(() => parse("click", { tab: "t1" })).toThrow(/one of them/)
    // Bounded, and a role is a word.
    expect(() =>
      parse("click", { tab: "t1", target: { role: "button", name: "" } }),
    ).toThrow()
    expect(() =>
      parse("click", {
        tab: "t1",
        target: { role: "button", name: "x".repeat(301) },
      }),
    ).toThrow()
    expect(() =>
      parse("click", {
        tab: "t1",
        target: { role: "button[name=x]", name: "x" },
      }),
    ).toThrow(/ARIA role/)
    expect(() =>
      parse("click", {
        tab: "t1",
        target: { role: "button", name: "x", nth: -1 },
      }),
    ).toThrow()
    expect(() =>
      parse("click", {
        tab: "t1",
        target: { role: "button", name: "x", within: "main" },
      }),
    ).toThrow(/ref looks like/)
    expect(parse("click", { tab: "t1", ref: "e2", force: true })).toEqual({
      tab: "t1",
      ref: "e2",
      force: true,
    })
  })

  it("describe every argument, the ones inside a target or a file too", () => {
    const undescribed: string[] = []
    const visit = (schema: Record<string, unknown>, at: string) => {
      const properties = (schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >

      for (const [name, property] of Object.entries(properties)) {
        if (typeof property.description !== "string") {
          undescribed.push(`${at}.${name}`)
        }

        visit(property, `${at}.${name}`)
        if (property.items) {
          visit(property.items as Record<string, unknown>, `${at}.${name}[]`)
        }
      }
    }

    for (const tool of browserTools()) {
      visit(tool.inputSchema as Record<string, unknown>, tool.name)
    }

    expect(undescribed).toEqual([])
  })

  it("take query for find's text, and only one of the two", () => {
    const find = browserToolSpec("find")!

    expect(BROWSER_ARG_ALIASES.find).toEqual({ query: "text" })
    expect(parseBrowserArgs(find, { tab: "t1", query: "Reply" })).toEqual({
      tab: "t1",
      text: "Reply",
    })
    expect(
      parseBrowserArgs(find, { tab: "t1", query: "Reply", text: "Reply" }),
    ).toEqual({ tab: "t1", text: "Reply" })
    expect(() =>
      parseBrowserArgs(find, { tab: "t1", query: "Reply", text: "Save" }),
    ).toThrow("find: query is another name for text; give one of them.")
    // The schema lists text alone.
    expect(
      Object.keys(
        (
          browserTools().find((tool) => tool.name === "find")!.inputSchema as {
            properties: Record<string, unknown>
          }
        ).properties,
      ),
    ).toEqual(["tab", "text", "within"])
    // Another tool takes no query.
    expect(() =>
      parseBrowserArgs(browserToolSpec("snapshot")!, {
        tab: "t1",
        query: "x",
      }),
    ).toThrow()
  })
})
