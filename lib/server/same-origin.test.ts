import { describe, expect, it } from "vitest"

import { isSameOrigin, originFromHeaders } from "./same-origin"

function request(headers: Record<string, string>): Request {
  return new Request("http://pcp.internal:3000/api/export", {
    method: "POST",
    headers,
  })
}

describe("originFromHeaders", () => {
  it("reads the host, or what a proxy says", () => {
    expect(originFromHeaders(new Headers({ host: "pcp.local:3000" }))).toBe(
      "http://pcp.local:3000",
    )
    expect(
      originFromHeaders(
        new Headers({
          host: "127.0.0.1:3000",
          "x-forwarded-host": "pcp.example, 127.0.0.1:3000",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://pcp.example")
  })
})

describe("isSameOrigin", () => {
  it("trusts the browser's own word first", () => {
    expect(
      isSameOrigin(
        request({ "sec-fetch-site": "same-origin", host: "pcp.local" }),
      ),
    ).toBe(true)
    expect(
      isSameOrigin(
        request({
          "sec-fetch-site": "cross-site",
          origin: "http://pcp.local",
          host: "pcp.local",
        }),
      ),
    ).toBe(false)
    expect(
      isSameOrigin(
        request({ "sec-fetch-site": "same-site", host: "pcp.local" }),
      ),
    ).toBe(false)
  })

  it("otherwise matches Origin against where the request arrived", () => {
    expect(
      isSameOrigin(
        request({ origin: "http://pcp.local:3000", host: "pcp.local:3000" }),
      ),
    ).toBe(true)
    expect(
      isSameOrigin(
        request({
          origin: "https://pcp.example",
          host: "127.0.0.1:3000",
          "x-forwarded-host": "pcp.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe(true)
    expect(
      isSameOrigin(
        request({ origin: "https://evil.example", host: "pcp.local" }),
      ),
    ).toBe(false)
  })

  it("refuses a request that says nothing about where it came from", () => {
    expect(isSameOrigin(request({ host: "pcp.local" }))).toBe(false)
  })
})
