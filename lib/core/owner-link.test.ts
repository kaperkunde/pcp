import { describe, expect, it } from "vitest"

import {
  linkLabel,
  linkLastText,
  markdownLink,
  MAX_LINK_LABEL,
  OWNER_LINK_RULE,
} from "./owner-link"

describe("linkLabel", () => {
  it("keeps a short plain label as it is", () => {
    expect(linkLabel("Allow gmail-imap/send_email?")).toBe(
      "Allow gmail-imap/send_email?",
    )
  })

  it("keeps it on one line, without brackets or markup", () => {
    expect(linkLabel("Allow [x](https://evil.example)\nnow​ `y` <b>\\")).toBe(
      "Allow x(https://evil.example) now y b",
    )
    expect(linkLabel("a b\tc")).toBe("a b c")
  })

  it("is at most MAX_LINK_LABEL characters", () => {
    const long = linkLabel(`Add the server ${"x".repeat(200)}?`)

    expect([...long]).toHaveLength(MAX_LINK_LABEL)
    expect(long.endsWith("…")).toBe(true)
    expect([...linkLabel("é".repeat(MAX_LINK_LABEL))]).toHaveLength(
      MAX_LINK_LABEL,
    )
  })

  it("names something when nothing is left", () => {
    expect(linkLabel("[]  \n")).toBe("Open in PCP")
  })
})

describe("markdownLink", () => {
  it("is [label](url), with what would end the address escaped", () => {
    expect(markdownLink("Allow it?", "https://pcp.x/permissions/a1")).toBe(
      "[Allow it?](https://pcp.x/permissions/a1)",
    )
    expect(markdownLink("Watch", "https://pcp.x/browser?tab=a(b) c")).toBe(
      "[Watch](https://pcp.x/browser?tab=a%28b%29%20c)",
    )
  })
})

describe("linkLastText", () => {
  it("says the rule, then ends with the markdown link on a line of its own", () => {
    const text = linkLastText("https://pcp.x/permissions/a1", "Allow x/y?")

    expect(text.startsWith(OWNER_LINK_RULE)).toBe(true)
    expect(text).toContain("never paste the bare address")
    expect(text.split("\n").at(-1)).toBe(
      "[Allow x/y?](https://pcp.x/permissions/a1)",
    )
    expect(text.split("\n")).toHaveLength(2)
  })
})
