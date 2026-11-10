import { afterEach, describe, expect, it, vi } from "vitest"

const sent = vi.hoisted(() => ({ headers: new Headers() }))

vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({ headers: async () => sent.headers }))

import { parseTrustedProxies } from "@kaperkunde/security"

import { clientIp } from "./client-ip"

async function ipFor(headers: Record<string, string>): Promise<string> {
  sent.headers = new Headers(headers)

  return clientIp()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("clientIp", () => {
  it("is the right-most address, the one the proxy in front appended", async () => {
    // What a client wrote itself sits to the left and is never reached.
    expect(await ipFor({ "x-forwarded-for": " 6.6.6.6 , 203.0.113.7" })).toBe(
      "203.0.113.7",
    )
    expect(await ipFor({ "x-forwarded-for": "2001:db8::1" })).toBe(
      "2001:db8::1",
    )
    expect(await ipFor({ "x-real-ip": "198.51.100.2" })).toBe("198.51.100.2")
  })

  it("is local with no header", async () => {
    expect(await ipFor({})).toBe("local")
    expect(await ipFor({ "x-forwarded-for": " " })).toBe("local")
  })

  it("keeps whatever is not an address short, and the same value on one key", async () => {
    const long = "x".repeat(16_000)
    const key = await ipFor({ "x-forwarded-for": long })

    expect(key.length).toBeLessThan(64)
    expect(await ipFor({ "x-forwarded-for": long })).toBe(key)
    expect(await ipFor({ "x-forwarded-for": `${long}y` })).not.toBe(key)
    expect(await ipFor({ "x-forwarded-for": "unknown" })).not.toBe(key)
  })
})

describe("clientIp behind trusted proxies", () => {
  it("walks from the right past the listed proxies and loopback", async () => {
    vi.stubEnv("PCP_TRUSTED_PROXIES", "10.0.0.0/8, 2001:db8:1::5")

    // What the client wrote itself is left of what the proxies appended.
    expect(
      await ipFor({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.1.2.3" }),
    ).toBe("203.0.113.7")
    expect(
      await ipFor({
        "x-forwarded-for": "6.6.6.6,203.0.113.7,2001:db8:1::5,127.0.0.1",
      }),
    ).toBe("203.0.113.7")
    expect(
      await ipFor({ "x-forwarded-for": "2001:db8::9, ::1, ::ffff:10.0.0.2" }),
    ).toBe("2001:db8::9")
    // A made-up address on the right is no proxy of PCP's.
    expect(await ipFor({ "x-forwarded-for": "203.0.113.7, 6.6.6.6" })).toBe(
      "6.6.6.6",
    )
  })

  it("is the left-most when every entry is trusted", async () => {
    vi.stubEnv("PCP_TRUSTED_PROXIES", "10.0.0.0/8")

    expect(await ipFor({ "x-forwarded-for": "10.0.0.4, 127.0.0.1" })).toBe(
      "10.0.0.4",
    )
    expect(await ipFor({ "x-forwarded-for": "::ffff:127.0.0.1" })).toBe(
      "127.0.0.1",
    )
  })

  it("does not read X-Real-IP, which a client can set", async () => {
    vi.stubEnv("PCP_TRUSTED_PROXIES", "10.0.0.0/8")

    expect(await ipFor({ "x-real-ip": "6.6.6.6" })).toBe("local")
    expect(
      await ipFor({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "6.6.6.6" }),
    ).toBe("203.0.113.7")
  })

  it("hashes an entry that is not an address, as without the setting", async () => {
    vi.stubEnv("PCP_TRUSTED_PROXIES", "10.0.0.0/8")
    const key = await ipFor({ "x-forwarded-for": "unknown, 10.0.0.1" })

    expect(key).toMatch(/^h:[0-9a-f]{32}$/)
  })

  it("stays as it was when the setting is empty", async () => {
    vi.stubEnv("PCP_TRUSTED_PROXIES", " ")

    expect(await ipFor({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" })).toBe(
      "203.0.113.7",
    )
  })
})

describe("parseTrustedProxies", () => {
  it("leaves out what is not an address or a range, and says which", () => {
    const invalid: string[] = []
    const list = parseTrustedProxies(
      "10.0.0.0/8, nope, 192.0.2.1/33, 2001:db8::/32, 198.51.100.0/24/1, 203.0.113.9/",
      (entry) => invalid.push(entry),
    )

    expect(invalid).toEqual([
      "nope",
      "192.0.2.1/33",
      "198.51.100.0/24/1",
      "203.0.113.9/",
    ])
    expect(list.check("10.9.9.9", "ipv4")).toBe(true)
    expect(list.check("2001:db8::1", "ipv6")).toBe(true)
    expect(list.check("127.0.0.1", "ipv4")).toBe(true)
    expect(list.check("::1", "ipv6")).toBe(true)
    expect(list.check("192.0.2.1", "ipv4")).toBe(false)
    expect(list.check("198.51.100.1", "ipv4")).toBe(false)
    expect(list.check("203.0.113.9", "ipv4")).toBe(false)
  })

  it("warns once for a setting, however many requests read it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("PCP_TRUSTED_PROXIES", "10.0.0.0/8, not-a-proxy")

    for (let i = 0; i < 3; i++) {
      expect(await ipFor({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBe(
        "203.0.113.7",
      )
    }

    expect(warn).toHaveBeenCalledTimes(1)
  })
})

// The app's own server entry (docker/peer-stamp.cjs) stamps the connecting
// address into x-pcp-peer; with it, forwarded headers count only from a proxy.
describe("clientIp with the connecting address known", () => {
  it("trusts forwarded headers from a loopback peer", async () => {
    expect(
      await ipFor({
        "x-pcp-peer": "127.0.0.1",
        "x-forwarded-for": "6.6.6.6, 203.0.113.7",
      }),
    ).toBe("203.0.113.7")
  })

  it("is the peer itself, not 'local', with no forwarded headers", async () => {
    expect(await ipFor({ "x-pcp-peer": "127.0.0.1" })).toBe("127.0.0.1")
    expect(await ipFor({ "x-pcp-peer": "::ffff:198.51.100.4" })).toBe(
      "198.51.100.4",
    )
  })

  it("ignores forwarded headers from another peer and warns once", async () => {
    vi.resetModules()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fresh = (await import("./client-ip")).clientIp
    const call = async (headers: Record<string, string>) => {
      sent.headers = new Headers(headers)

      return fresh()
    }
    const forged = {
      "x-pcp-peer": "172.18.0.2",
      "x-forwarded-for": "6.6.6.6",
    }

    expect(await call(forged)).toBe("172.18.0.2")
    expect(await call({ ...forged, "x-forwarded-for": "7.7.7.7" })).toBe(
      "172.18.0.2",
    )
    expect(
      await call({ "x-pcp-peer": "172.18.0.2", "x-real-ip": "8.8.8.8" }),
    ).toBe("172.18.0.2")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("PCP_TRUSTED_PROXIES")
    // Not the address of anyone who connected.
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("172.18.0.2")
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("6.6.6.6")
  })

  it("does not warn when the peer sends no forwarded headers", async () => {
    vi.resetModules()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fresh = (await import("./client-ip")).clientIp

    sent.headers = new Headers({ "x-pcp-peer": "203.0.113.50" })
    expect(await fresh()).toBe("203.0.113.50")
    expect(warn).not.toHaveBeenCalled()
  })

  it("reads forwarded headers from a peer inside PCP_TRUSTED_PROXIES", async () => {
    vi.resetModules()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("PCP_TRUSTED_PROXIES", "172.16.0.0/12")
    const fresh = (await import("./client-ip")).clientIp

    sent.headers = new Headers({
      "x-pcp-peer": "172.18.0.2",
      "x-forwarded-for": "6.6.6.6, 203.0.113.7",
    })
    expect(await fresh()).toBe("203.0.113.7")
    expect(warn).not.toHaveBeenCalled()
  })
})
