import { describe, expect, it } from "vitest"

import {
  authOf,
  buildRequest,
  plain,
  readResults,
  searxngSearchUrl,
  WEB_SEARCH_PROVIDERS,
  type SearchParams,
} from "./providers"

const PARAMS: SearchParams = {
  query: "pcp gateway",
  limit: 5,
  region: "nl",
  language: "en",
  freshness: "week",
}

describe("a search request, by provider", () => {
  it("asks Brave with its query string and the key in X-Subscription-Token", () => {
    const request = buildRequest("brave", PARAMS)
    const url = new URL(request.url)

    expect(request.method).toBe("GET")
    expect(url.host).toBe("api.search.brave.com")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "pcp gateway",
      count: "5",
      country: "nl",
      search_lang: "en",
      freshness: "pw",
    })
    expect(request.auth).toEqual({ header: "X-Subscription-Token", prefix: "" })
  })

  it("asks Tavily, Exa and Serper with a JSON body and their own header", () => {
    const tavily = buildRequest("tavily", PARAMS)
    expect(tavily.method).toBe("POST")
    expect(JSON.parse(tavily.body!)).toMatchObject({
      query: "pcp gateway",
      max_results: 5,
      time_range: "week",
    })
    expect(tavily.auth).toEqual({ header: "Authorization", prefix: "Bearer " })

    const now = Date.parse("2026-11-27T00:00:00Z")
    const exa = buildRequest("exa", PARAMS, { now })
    expect(JSON.parse(exa.body!)).toMatchObject({
      query: "pcp gateway",
      numResults: 5,
      startPublishedDate: "2026-11-20T00:00:00.000Z",
    })
    expect(exa.auth.header).toBe("x-api-key")

    const serper = buildRequest("serper", PARAMS)
    expect(JSON.parse(serper.body!)).toEqual({
      q: "pcp gateway",
      num: 5,
      gl: "nl",
      hl: "en",
      tbs: "qdr:w",
    })
    expect(serper.auth.header).toBe("X-API-KEY")
  })

  it("asks a search server of the owner's at its own address, with format=json", () => {
    const request = buildRequest("searxng", PARAMS, {
      base: "http://192.168.1.20:8080/",
    })
    const url = new URL(request.url)

    expect(url.origin + url.pathname).toBe("http://192.168.1.20:8080/search")
    expect(url.searchParams.get("format")).toBe("json")
    expect(url.searchParams.get("time_range")).toBe("week")
    expect(searxngSearchUrl("https://s.example/sub/search/").pathname).toBe(
      "/sub/search",
    )
  })

  it("names a header and a prefix for every provider", () => {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      expect(authOf(provider).header, provider).toMatch(/^[A-Za-z-]+$/)
    }
  })
})

describe("the results read from an answer", () => {
  it("reads each provider's shape into title, address, snippet and date", () => {
    expect(
      readResults(
        "brave",
        {
          web: {
            results: [
              {
                title: "A",
                url: "https://a.example/",
                description: "about a",
                page_age: "2026-11-01",
              },
            ],
          },
        },
        10,
      ),
    ).toEqual([
      {
        title: "A",
        url: "https://a.example/",
        snippet: "about a",
        published: "2026-11-01",
      },
    ])
    expect(
      readResults(
        "tavily",
        { results: [{ title: "T", url: "https://t.example/", content: "c" }] },
        10,
      ),
    ).toEqual([{ title: "T", url: "https://t.example/", snippet: "c" }])
    expect(
      readResults(
        "exa",
        {
          results: [
            {
              title: "E",
              url: "https://e.example/",
              highlights: ["one", "two"],
              publishedDate: "2026-10-30",
            },
          ],
        },
        10,
      ),
    ).toEqual([
      {
        title: "E",
        url: "https://e.example/",
        snippet: "one … two",
        published: "2026-10-30",
      },
    ])
    expect(
      readResults(
        "serper",
        { organic: [{ title: "S", link: "https://s.example/", snippet: "s" }] },
        10,
      ),
    ).toEqual([{ title: "S", url: "https://s.example/", snippet: "s" }])
    expect(
      readResults(
        "searxng",
        { results: [{ title: "X", url: "https://x.example/", content: "x" }] },
        10,
      ),
    ).toEqual([{ title: "X", url: "https://x.example/", snippet: "x" }])
  })

  it("takes an answer that is not one as none, and an empty one as no results", () => {
    expect(readResults("tavily", { error: "no" }, 5)).toBeNull()
    expect(readResults("brave", "text", 5)).toBeNull()
    expect(readResults("serper", { organic: [] }, 5)).toEqual([])
  })

  it("keeps only http(s) addresses without credentials, and at most the limit", () => {
    const rows = [
      "javascript:alert(1)",
      "ftp://x.example/",
      "https://user:pw@x.example/",
      "not a url",
      "https://ok.example/1",
      "https://ok.example/2",
      "https://ok.example/3",
    ].map((url) => ({ title: "t", url, content: "c" }))

    expect(
      readResults("tavily", { results: rows }, 2)!.map((row) => row.url),
    ).toEqual(["https://ok.example/1", "https://ok.example/2"])
  })

  it("cleans a text: no hidden characters, one line, bounded", () => {
    expect(plain("a​b‮c\n\n  d\u0007", 50)).toBe("abc d")
    expect(plain("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`)
    expect(plain(42, 10)).toBe("")
  })
})
