import { describe, expect, it } from "vitest"

import { tabHost, tabInitial, tabState } from "./browser-tabs"

describe("a tab in the tabs view", () => {
  it("is named by its site", () => {
    expect(tabHost("https://example.com/login?next=/")).toBe("example.com")
    expect(tabHost("http://127.0.0.1:8080/form")).toBe("127.0.0.1:8080")
    expect(tabHost("about:blank")).toBe("about:blank")
    expect(tabHost("not an address")).toBe("not an address")
  })

  it("stands its site's first letter in for an icon it has none of", () => {
    expect(tabInitial("https://www.example.com/")).toBe("E")
    expect(tabInitial("https://github.com/kaperkunde")).toBe("G")
    expect(tabInitial("http://127.0.0.1:3000/")).toBe("1")
    expect(tabInitial("about:blank")).toBe("·")
    expect(tabInitial("")).toBe("·")
  })

  it("is with you while you have it, else in use or idle", () => {
    expect(tabState({ control: "owner", busy: true })).toBe("owner")
    expect(tabState({ control: "assistant", busy: true })).toBe("busy")
    expect(tabState({ control: "assistant", busy: false })).toBe("idle")
  })
})
