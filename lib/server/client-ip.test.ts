import { describe, expect, it, vi } from "vitest"

const sent = vi.hoisted(() => ({ headers: new Headers() }))

vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({ headers: async () => sent.headers }))

import { clientIp } from "./client-ip"

async function ipFor(headers: Record<string, string>): Promise<string> {
  sent.headers = new Headers(headers)

  return clientIp()
}

describe("clientIp", () => {
  it("is the left-most address a proxy reports, as it is", async () => {
    expect(await ipFor({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" })).toBe(
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
