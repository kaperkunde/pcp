import { describe, expect, it } from "vitest"

import {
  emptyRules,
  methodGroup,
  normalizeMethod,
  normalizeSite,
  resolveFetchAccess,
  resolvePrivateAccess,
  siteKey,
} from "./rules"

// Which level a web_fetch request gets: the site's line, then the method's,
// the token's own before all tokens', and ask when nothing says.

describe("methods", () => {
  it("upper-cases, defaults to GET and groups the rest as other", () => {
    expect(normalizeMethod(undefined)).toBe("GET")
    expect(normalizeMethod(" post ")).toBe("POST")
    expect(methodGroup("PATCH")).toBe("PATCH")
    expect(methodGroup("HEAD")).toBe("OTHER")
    expect(methodGroup("PROPFIND")).toBe("OTHER")
    // A method named like the group is still just another method.
    expect(methodGroup("OTHER")).toBe("OTHER")
  })

  it("refuses tunnels, echoes and names that are not methods", () => {
    expect(() => normalizeMethod("CONNECT")).toThrow(/does not send CONNECT/)
    expect(() => normalizeMethod("trace")).toThrow(/does not send TRACE/)
    expect(() => normalizeMethod("GET /admin")).toThrow(/name like GET/)
  })
})

describe("sites", () => {
  it("is the host, with a port only when it is not the scheme's own", () => {
    expect(siteKey(new URL("https://Example.COM/a?b"))).toBe("example.com")
    expect(siteKey(new URL("http://example.com/"))).toBe("example.com")
    expect(siteKey(new URL("https://example.com:443/"))).toBe("example.com")
    expect(siteKey(new URL("https://example.com:8443/"))).toBe(
      "example.com:8443",
    )
    expect(siteKey(new URL("https://www.example.com/"))).toBe("www.example.com")
  })

  it("reads what the owner types as a site", () => {
    expect(normalizeSite("example.com")).toBe("example.com")
    expect(normalizeSite(" https://Docs.Example.com/guide ")).toBe(
      "docs.example.com",
    )
    expect(normalizeSite("example.com:8080")).toBe("example.com:8080")
    expect(() => normalizeSite("")).toThrow(/Enter a site/)
    expect(() => normalizeSite("*.example.com")).toThrow(/no wildcards/)
    expect(() => normalizeSite("ftp://example.com")).toThrow(/http/)
    expect(() => normalizeSite("https://me:pw@example.com")).toThrow(
      /user name/,
    )
  })
})

describe("deciding a request", () => {
  it("asks when nothing is set", () => {
    expect(resolveFetchAccess(emptyRules(), "example.com", "GET")).toEqual({
      access: "ask",
      by: "default",
    })
  })

  it("takes the method's level, the token's own before all tokens'", () => {
    const rules = emptyRules()
    rules.sharedMethods.set("GET", "allowed")
    expect(resolveFetchAccess(rules, "example.com", "GET")).toEqual({
      access: "allowed",
      by: "method",
    })

    rules.ownMethods.set("GET", "ask")
    expect(resolveFetchAccess(rules, "example.com", "GET").access).toBe("ask")
    expect(resolveFetchAccess(rules, "example.com", "POST").access).toBe("ask")
  })

  it("lets a site's line decide every method, the token's own first", () => {
    const rules = emptyRules()
    rules.ownMethods.set("GET", "allowed")
    rules.sharedSites.set("example.com", "blocked")

    expect(resolveFetchAccess(rules, "example.com", "GET")).toEqual({
      access: "blocked",
      by: "site",
    })
    expect(resolveFetchAccess(rules, "other.example", "GET").access).toBe(
      "allowed",
    )

    rules.ownSites.set("example.com", "allowed")
    expect(resolveFetchAccess(rules, "example.com", "DELETE").access).toBe(
      "allowed",
    )
  })

  it("sends a token's own site at the method settings to the methods, past all tokens' line", () => {
    const rules = emptyRules()
    rules.sharedSites.set("example.com", "allowed")
    rules.ownSites.set("example.com", null)

    expect(resolveFetchAccess(rules, "example.com", "GET")).toEqual({
      access: "ask",
      by: "default",
    })

    // Without a line of its own, the token follows all tokens' one.
    rules.ownSites.delete("example.com")
    expect(resolveFetchAccess(rules, "example.com", "GET").access).toBe(
      "allowed",
    )

    // And a line for all tokens at the method settings follows the methods.
    rules.sharedSites.set("example.com", null)
    rules.sharedMethods.set("GET", "blocked")
    expect(resolveFetchAccess(rules, "example.com", "GET")).toEqual({
      access: "blocked",
      by: "method",
    })
  })
})

describe("private addresses", () => {
  it("are blocked without a line, and the token's own line wins over all tokens'", () => {
    const rules = emptyRules()
    expect(resolvePrivateAccess(rules)).toBe(false)

    rules.sharedPrivate = "allowed"
    expect(resolvePrivateAccess(rules)).toBe(true)

    rules.ownPrivate = "blocked"
    expect(resolvePrivateAccess(rules)).toBe(false)

    rules.sharedPrivate = null
    rules.ownPrivate = "allowed"
    expect(resolvePrivateAccess(rules)).toBe(true)
  })

  it("never come from asking: only allowed allows", () => {
    const rules = emptyRules()
    rules.ownPrivate = "ask"
    expect(resolvePrivateAccess(rules)).toBe(false)
  })
})
