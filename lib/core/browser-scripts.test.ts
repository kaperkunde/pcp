import { describe, expect, it } from "vitest"

import {
  normalizeReachHost,
  reachHosts,
  scriptReaches,
} from "./browser-scripts"

// Where a script run by evaluate may reach while it runs: its own site's
// registrable domain, and the hosts the owner allowed for that site.

describe("scriptReaches", () => {
  it("reaches any host of the site's registrable domain", () => {
    expect(scriptReaches("bestellen.dominos.nl", "olo-graph.dominos.nl")).toBe(
      true,
    )
    expect(scriptReaches("bestellen.dominos.nl", "dominos.nl")).toBe(true)
    expect(scriptReaches("www.example.co.uk", "api.example.co.uk")).toBe(true)
    expect(scriptReaches("dominos.nl:8443", "api.dominos.nl:9000")).toBe(true)
    expect(scriptReaches("shop.example", "shop.example")).toBe(true)
  })

  it("refuses another domain, and a name that only ends the same", () => {
    expect(scriptReaches("bestellen.dominos.nl", "evil.test")).toBe(false)
    expect(scriptReaches("bestellen.dominos.nl", "notdominos.nl")).toBe(false)
    expect(scriptReaches("bestellen.dominos.nl", "dominos.nl.evil.test")).toBe(
      false,
    )
  })

  it("treats each host under a public suffix as its own site", () => {
    expect(scriptReaches("a.github.io", "b.github.io")).toBe(false)
    expect(scriptReaches("a.github.io", "github.io")).toBe(false)
    expect(scriptReaches("a.github.io", "x.a.github.io")).toBe(true)
    expect(scriptReaches("shop.co.uk", "other.co.uk")).toBe(false)
  })

  it("never widens an IP address or localhost", () => {
    expect(scriptReaches("127.0.0.1:3000", "127.0.0.1:4000")).toBe(false)
    expect(scriptReaches("127.0.0.1", "10.0.0.1")).toBe(false)
    expect(scriptReaches("localhost:3000", "localhost:4000")).toBe(false)
    expect(scriptReaches("localhost", "api.localhost")).toBe(false)
    expect(scriptReaches("[::1]", "[::2]")).toBe(false)
    // Not even where the owner listed them.
    const extras = new Set(["127.0.0.1", "localhost", "10.0.0.1"])
    expect(scriptReaches("a.example.com", "127.0.0.1", extras)).toBe(false)
    expect(scriptReaches("a.example.com", "localhost", extras)).toBe(false)
    expect(scriptReaches("a.example.com", "10.0.0.1", extras)).toBe(false)
  })

  it("reaches the owner's extra hosts, and only those", () => {
    const extras = new Set(["cdn.example.net", "api.other.test:8443"])

    expect(scriptReaches("shop.example", "cdn.example.net", extras)).toBe(true)
    expect(scriptReaches("shop.example", "api.other.test:8443", extras)).toBe(
      true,
    )
    expect(scriptReaches("shop.example", "other.example.net", extras)).toBe(
      false,
    )
    // The same host at another port is not what was allowed, but a host
    // allowed without a port is that host at any port.
    expect(scriptReaches("shop.example", "api.other.test:9", extras)).toBe(
      false,
    )
    expect(scriptReaches("shop.example", "cdn.example.net:81", extras)).toBe(
      true,
    )
    // No extras for another site.
    expect(scriptReaches("shop.example", "cdn.example.net")).toBe(false)
  })
})

describe("reach hosts", () => {
  it("takes names only", () => {
    expect(normalizeReachHost(" CDN.Example.net. ")).toBe("cdn.example.net")
    expect(normalizeReachHost("api.example.net:8443")).toBe(
      "api.example.net:8443",
    )

    for (const bad of [
      "https://cdn.example.net",
      "cdn.example.net/path",
      "127.0.0.1",
      "[::1]",
      "localhost",
      "a b.example",
      "",
      42,
    ]) {
      expect(normalizeReachHost(bad)).toBeNull()
    }
  })

  it("keeps each once, and at most ten", () => {
    expect(reachHosts(["a.example.net", "A.example.net"])).toEqual([
      "a.example.net",
    ])
    expect(reachHosts(["a.example.net", "nope"])).toBeNull()
    expect(
      reachHosts(Array.from({ length: 11 }, (_, i) => `h${i}.example.net`)),
    ).toBeNull()
  })
})
