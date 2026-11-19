import { describe, expect, it } from "vitest"

import { httpThrottle, plainHeaders } from "./throttle-signal"

// Playwright's response.headers() joins a header sent several times with a
// newline, which the WHATWG Headers constructor refuses: Google sends
// several Content-Security-Policy headers, and opening its pages failed.
describe("plainHeaders", () => {
  const sent = {
    "content-security-policy":
      "script-src 'report-sample' 'nonce-abc' 'unsafe-inline';object-src 'none'\nbase-uri 'self'",
    "retry-after": "30",
  }

  it("is what WHATWG Headers refuses", () => {
    expect(() => new Headers(sent)).toThrow()
  })

  it("reads a header by any case, and never throws on a joined one", () => {
    const headers = plainHeaders(sent)

    expect(headers.get("Retry-After")).toBe("30")
    expect(headers.get("content-security-policy")).toContain("report-sample")
    expect(headers.get("x-missing")).toBeNull()
  })

  it("feeds httpThrottle", () => {
    expect(httpThrottle(429, plainHeaders(sent), "Google")).toEqual({
      reason: "Google answered HTTP 429: it asks PCP to slow down",
      retryAfterMs: 30_000,
    })
  })
})
