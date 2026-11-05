import { describe, expect, it } from "vitest"

import { editDistance, lookalikeReason } from "./lookalike-sites"

// A site proposed for a secret that looks like one it has without being it
// (#72) is flagged on the request's page; one under a domain it has is not.

const KNOWN = [
  { host: "www.frankenergie.nl", domain: "frankenergie.nl" },
  { host: "example.com", domain: "example.com" },
]

describe("lookalikeReason", () => {
  it("passes a host under a domain the secret has, and an unrelated one", () => {
    expect(
      lookalikeReason("mijn.frankenergie.nl", "frankenergie.nl", KNOWN),
    ).toBe(null)
    expect(lookalikeReason("waternet.nl", "waternet.nl", KNOWN)).toBe(null)
  })

  it("flags a near miss, a homoglyph, another ending and a borrowed name", () => {
    expect(
      lookalikeReason("www.frankenergy.nl", "frankenergy.nl", KNOWN),
    ).toMatch(/letter or two away from frankenergie\.nl/)
    expect(lookalikeReason("examp1e.com", "examp1e.com", KNOWN)).toMatch(
      /looks like example\.com/,
    )
    expect(lookalikeReason("exarnple.com", "exarnple.com", KNOWN)).toMatch(
      /looks like example\.com/,
    )
    expect(lookalikeReason("example.co", "example.co", KNOWN)).toMatch(
      /same name as example\.com/,
    )
    expect(
      lookalikeReason("example.com.login.net", "login.net", KNOWN),
    ).toMatch(/has example in its name but belongs to login\.net/)
    expect(
      lookalikeReason("xn--exmple-cua.com", "xn--exmple-cua.com", KNOWN),
    ).toMatch(/other alphabets \(exämple\.com\)/)
  })
})

describe("editDistance", () => {
  it("counts edits, and stops past the bound", () => {
    expect(editDistance("frankenergy", "frankenergie")).toBe(2)
    expect(editDistance("kitten", "sitting")).toBe(3)
    expect(editDistance("a", "abcdefgh", 2)).toBe(3)
  })
})
