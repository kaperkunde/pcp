import { describe, expect, it } from "vitest"

import { MAX_FETCH_BODY_BYTES, MAX_FETCH_HEADERS } from "./limits"
import { prepareFetch } from "./request"

// web_fetch's arguments, checked before the owner is asked about them.

describe("preparing a request", () => {
  it("defaults to GET, drops the fragment and keeps only what was given", () => {
    expect(prepareFetch({ url: "https://example.com/a?b=1#top" })).toEqual({
      url: "https://example.com/a?b=1",
      method: "GET",
      headers: {},
    })

    expect(
      prepareFetch({
        url: "https://example.com/api",
        method: "post",
        headers: { Accept: "application/json", "X-Trace": "1" },
        body: '{"a":1}',
        raw: true,
        max_length: 100,
        start_index: 50,
      }),
    ).toEqual({
      url: "https://example.com/api",
      method: "POST",
      headers: { accept: "application/json", "x-trace": "1" },
      body: '{"a":1}',
      raw: true,
      maxLength: 100,
      startIndex: 50,
    })
  })

  it("refuses addresses it cannot or should not send", () => {
    expect(() => prepareFetch({ url: "" })).toThrow(/full address/)
    expect(() => prepareFetch({ url: "example.com" })).toThrow(/full address/)
    expect(() => prepareFetch({ url: "file:///etc/passwd" })).toThrow(
      /http:\/\/ and https:\/\//,
    )
    expect(() => prepareFetch({ url: "https://me:pw@example.com/" })).toThrow(
      /user name or password/,
    )
  })

  it("never sends a credential, a cookie or a header PCP owns", () => {
    for (const name of [
      "Authorization",
      "cookie",
      "Host",
      "proxy-authorization",
      "x-forwarded-for",
      "user-agent",
    ]) {
      expect(() =>
        prepareFetch({ url: "https://example.com/", headers: { [name]: "x" } }),
      ).toThrow(/does not send a/)
    }

    expect(() =>
      prepareFetch({
        url: "https://example.com/",
        headers: { "x-a": "line\r\nbreak" },
      }),
    ).toThrow(/cannot be sent/)
    expect(() =>
      prepareFetch({
        url: "https://example.com/",
        headers: { Accept: "a", accept: "b" },
      }),
    ).toThrow(/given twice/)
    expect(() =>
      prepareFetch({
        url: "https://example.com/",
        headers: Object.fromEntries(
          Array.from({ length: MAX_FETCH_HEADERS + 1 }, (_, i) => [
            `x-${i}`,
            "1",
          ]),
        ),
      }),
    ).toThrow(/at most/)
  })

  it("keeps a body to methods that have one, and to its limit", () => {
    expect(() =>
      prepareFetch({ url: "https://example.com/", body: "a=1" }),
    ).toThrow(/GET request has no body/)
    expect(() =>
      prepareFetch({
        url: "https://example.com/",
        method: "POST",
        body: "x".repeat(MAX_FETCH_BODY_BYTES + 1),
      }),
    ).toThrow(/under 1 MB/)
    expect(() =>
      prepareFetch({ url: "https://example.com/", method: "CONNECT" }),
    ).toThrow(/does not send CONNECT/)
    expect(() =>
      prepareFetch({ url: "https://example.com/", max_length: 0 }),
    ).toThrow(/max_length/)
  })
})
