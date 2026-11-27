import { afterEach, describe, expect, it, vi } from "vitest"

import { requestSearch, type PreparedSearch } from "./request"

// Each hosted provider's request as it goes out, and what comes of each
// answer, against a fake fetch: no key leaves except in its own header.

const KEY = "tvly-0123456789"

function prepared(
  provider: PreparedSearch["provider"],
  prefix = "",
): PreparedSearch {
  return {
    provider,
    host: "provider.example",
    label: "The provider",
    fingerprint: provider,
    key: `${prefix}${KEY}`,
    redact: [KEY],
    sendOptions: {},
  }
}

function answerWith(status: number, body: unknown, headers = {}) {
  const fetched = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers,
      }),
  )

  vi.stubGlobal("fetch", fetched)
  return fetched
}

const signal = () => new AbortController().signal

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("requestSearch", () => {
  it("sends Brave's key in its own header, and reads the answer", async () => {
    const fetched = answerWith(200, {
      web: {
        results: [{ title: "A", url: "https://a.example/", description: "d" }],
      },
    })

    const answer = await requestSearch(
      prepared("brave"),
      { query: "pcp", limit: 3 },
      signal(),
    )

    expect(answer).toMatchObject({
      kind: "ok",
      results: [{ title: "A", url: "https://a.example/", snippet: "d" }],
    })
    const [url, init] = fetched.mock.calls[0]!
    expect(String(url)).toContain("api.search.brave.com")
    expect(
      (init!.headers as Record<string, string>)["X-Subscription-Token"],
    ).toBe(KEY)
    expect(init!.redirect).toBe("manual")
  })

  it("posts Tavily's body with a bearer key and nothing of the key in the body", async () => {
    const fetched = answerWith(200, { results: [] })

    await requestSearch(
      prepared("tavily", "Bearer "),
      { query: "pcp", limit: 3 },
      signal(),
    )

    const [, init] = fetched.mock.calls[0]!
    expect(init!.method).toBe("POST")
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    )
    expect(String(init!.body)).not.toContain(KEY)
  })

  it("says the key was refused, without the key", async () => {
    answerWith(401, {})

    const answer = await requestSearch(
      prepared("serper"),
      { query: "pcp", limit: 3 },
      signal(),
    )

    expect(answer).toMatchObject({ kind: "failed", unauthorized: true })
    expect(JSON.stringify(answer)).not.toContain(KEY)
  })

  it("carries a refusal for rate as the gate's signal", async () => {
    answerWith(429, {}, { "retry-after": "30" })

    const answer = await requestSearch(
      prepared("exa"),
      { query: "pcp", limit: 3 },
      signal(),
    )

    expect(answer).toMatchObject({
      kind: "failed",
      throttle: { retryAfterMs: 30_000 },
    })
  })

  it("does not take an answer that is not JSON, or not results, or too long", async () => {
    answerWith(200, "<html>")
    expect(
      await requestSearch(
        prepared("brave"),
        { query: "q", limit: 1 },
        signal(),
      ),
    ).toMatchObject({ kind: "failed", message: expect.stringMatching(/JSON/) })

    answerWith(200, { nothing: true })
    expect(
      await requestSearch(
        prepared("tavily"),
        { query: "q", limit: 1 },
        signal(),
      ),
    ).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/search results/),
    })
  })

  it("scrubs the key from what the provider says back", async () => {
    answerWith(200, {
      results: [
        { title: `echo ${KEY}`, url: "https://a.example/", content: KEY },
      ],
    })

    const answer = await requestSearch(
      prepared("tavily"),
      { query: "q", limit: 1 },
      signal(),
    )

    expect(JSON.stringify(answer)).not.toContain(KEY)
  })

  it("goes on when the caller's own signal aborts: it throws, as nothing was answered", async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort()
        throw new DOMException("aborted", "AbortError")
      }),
    )

    await expect(
      requestSearch(
        prepared("brave"),
        { query: "q", limit: 1 },
        controller.signal,
      ),
    ).rejects.toThrow()
  })
})
