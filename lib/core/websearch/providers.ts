import {
  WEB_SEARCH_MAX_SNIPPET_CHARS,
  WEB_SEARCH_MAX_TITLE_CHARS,
  WEB_SEARCH_MAX_URL_CHARS,
} from "./limits"

/**
 * The search providers PCP can use for web_search, each an adapter of two
 * pure functions: the request for a search (the address, the body, and
 * which header carries the key: upstream.ts makes the header from the
 * owner's secret, never here) and the results read from the answer. The
 * answer is untrusted input: read against what it should be, every text
 * bounded, every address http(s).
 *
 * Which of them is still true of the provider's API is the owner's to find
 * out on Settings → Web search, which tries one search before it saves.
 */

export const WEB_SEARCH_PROVIDERS = [
  "brave",
  "tavily",
  "exa",
  "serper",
  "searxng",
] as const

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number]

export function isWebSearchProvider(
  value: unknown,
): value is WebSearchProvider {
  return (WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(value)
}

export const FRESHNESS = ["day", "week", "month", "year"] as const
export type Freshness = (typeof FRESHNESS)[number]

/** What a search asks for. */
export type SearchParams = {
  query: string
  limit: number
  /** A two-letter country code, lower case ("nl"). */
  region?: string
  /** A two-letter language code, lower case ("en"). */
  language?: string
  freshness?: Freshness
}

/** One result, as an assistant gets it. */
export type SearchResult = {
  title: string
  url: string
  snippet: string
  published?: string
}

/** What a provider is, for the owner's page and the request. */
export type ProviderInfo = {
  id: WebSearchProvider
  title: string
  /** One line: what it is and what it costs, for the settings card. */
  about: string
  /** Where the owner makes a key; null for one they run themselves. */
  keyAt: string | null
  /** The key is optional (a self-hosted search). */
  keyOptional: boolean
  /** The owner types the address (a self-hosted search). */
  ownAddress: boolean
  /** The provider's own public address; null when the owner types it. */
  host: string | null
  regions: boolean
  languages: boolean
  freshness: boolean
}

export const PROVIDER_INFO: Record<WebSearchProvider, ProviderInfo> = {
  brave: {
    id: "brave",
    title: "Brave Search API",
    about:
      "Brave's own web index, results as JSON, built for apps and agents. Pay as you go (about $5 per 1,000 searches, with a small monthly credit); needs a card on file.",
    keyAt: "api-dashboard.search.brave.com",
    keyOptional: false,
    ownAddress: false,
    host: "api.search.brave.com",
    regions: true,
    languages: true,
    freshness: true,
  },
  tavily: {
    id: "tavily",
    title: "Tavily",
    about:
      "A search API made for AI agents: ranked results with a relevant excerpt each. A free monthly allowance, then pay as you go.",
    keyAt: "tavily.com",
    keyOptional: false,
    ownAddress: false,
    host: "api.tavily.com",
    regions: false,
    languages: false,
    freshness: true,
  },
  exa: {
    id: "exa",
    title: "Exa",
    about:
      "A search engine for AI that matches meaning as well as words, with highlights from each page. Pay as you go, with starting credit.",
    keyAt: "exa.ai",
    keyOptional: false,
    ownAddress: false,
    host: "api.exa.ai",
    regions: true,
    languages: false,
    freshness: true,
  },
  serper: {
    id: "serper",
    title: "Serper",
    about:
      "Google's results as JSON through Serper's API. Cheap per search; a free starting allowance, then prepaid credits.",
    keyAt: "serper.dev",
    keyOptional: false,
    ownAddress: false,
    host: "google.serper.dev",
    regions: true,
    languages: true,
    freshness: true,
  },
  searxng: {
    id: "searxng",
    title: "SearXNG (your own)",
    about:
      "A search server you run yourself, which asks other engines for you and keeps no account. Free, and nothing leaves your network but its own requests. It must answer JSON (format=json is switched on in its settings).",
    keyAt: null,
    keyOptional: true,
    ownAddress: true,
    host: null,
    regions: false,
    languages: true,
    freshness: true,
  },
}

/** The address a request goes to, for the gate and pacing, by its host. */
export type SearchRequest = {
  method: "GET" | "POST"
  url: string
  /** The body of a POST, as JSON text. */
  body?: string
  /** What names the key: a header, and the word before the key if any. */
  auth: { header: string; prefix: string }
}

/** Which header carries each provider's key, and the word before it. */
const AUTH: Record<WebSearchProvider, { header: string; prefix: string }> = {
  brave: { header: "X-Subscription-Token", prefix: "" },
  tavily: { header: "Authorization", prefix: "Bearer " },
  exa: { header: "x-api-key", prefix: "" },
  serper: { header: "X-API-KEY", prefix: "" },
  searxng: { header: "Authorization", prefix: "Bearer " },
}

export function authOf(provider: WebSearchProvider) {
  return AUTH[provider]
}

const BRAVE_FRESH: Record<Freshness, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
}
const TIME_RANGE: Record<Freshness, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
}
const SERPER_FRESH: Record<Freshness, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
}
const DAY_MS = 24 * 60 * 60 * 1000
const FRESH_DAYS: Record<Freshness, number> = {
  day: 1,
  week: 7,
  month: 31,
  year: 366,
}

/** SearXNG's base address as the owner typed it, with its /search path. */
export function searxngSearchUrl(base: string): URL {
  const url = new URL(base)
  const path = url.pathname.replace(/\/+$/, "")

  url.pathname = path.endsWith("/search") ? path : `${path}/search`
  url.search = ""
  url.hash = ""
  return url
}

/**
 * The request for a search. `base` is the owner's address, for a provider
 * they run; `now` is for tests.
 */
export function buildRequest(
  provider: WebSearchProvider,
  params: SearchParams,
  { base, now = Date.now() }: { base?: string; now?: number } = {},
): SearchRequest {
  switch (provider) {
    case "brave": {
      const url = new URL("https://api.search.brave.com/res/v1/web/search")

      url.searchParams.set("q", params.query)
      url.searchParams.set("count", String(params.limit))
      if (params.region) url.searchParams.set("country", params.region)
      if (params.language) url.searchParams.set("search_lang", params.language)
      if (params.freshness) {
        url.searchParams.set("freshness", BRAVE_FRESH[params.freshness])
      }

      return {
        method: "GET",
        url: url.toString(),
        auth: AUTH[provider],
      }
    }
    case "tavily":
      return {
        method: "POST",
        url: "https://api.tavily.com/search",
        body: JSON.stringify({
          query: params.query,
          max_results: params.limit,
          search_depth: "basic",
          ...(params.freshness
            ? { time_range: TIME_RANGE[params.freshness] }
            : {}),
        }),
        auth: AUTH[provider],
      }
    case "exa":
      return {
        method: "POST",
        url: "https://api.exa.ai/search",
        body: JSON.stringify({
          query: params.query,
          numResults: params.limit,
          type: "auto",
          ...(params.region
            ? { userLocation: params.region.toUpperCase() }
            : {}),
          ...(params.freshness
            ? {
                startPublishedDate: new Date(
                  now - FRESH_DAYS[params.freshness] * DAY_MS,
                ).toISOString(),
              }
            : {}),
          contents: { highlights: true },
        }),
        auth: AUTH[provider],
      }
    case "serper":
      return {
        method: "POST",
        url: "https://google.serper.dev/search",
        body: JSON.stringify({
          q: params.query,
          num: params.limit,
          ...(params.region ? { gl: params.region } : {}),
          ...(params.language ? { hl: params.language } : {}),
          ...(params.freshness ? { tbs: SERPER_FRESH[params.freshness] } : {}),
        }),
        auth: AUTH[provider],
      }
    case "searxng": {
      const url = searxngSearchUrl(base ?? "")

      url.searchParams.set("q", params.query)
      url.searchParams.set("format", "json")
      if (params.language) url.searchParams.set("language", params.language)
      if (params.freshness) {
        url.searchParams.set("time_range", TIME_RANGE[params.freshness])
      }

      return {
        method: "GET",
        url: url.toString(),
        auth: AUTH[provider],
      }
    }
  }
}

// ---- Reading an answer -----------------------------------------------------

/** Characters that do not show on screen, and control characters. */
const HIDDEN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g

/** A text from an answer: no hidden characters, one line of spaces, cut. */
export function plain(value: unknown, max: number): string {
  if (typeof value !== "string") {
    return ""
  }

  const text = value.replace(HIDDEN, "").replace(/\s+/g, " ").trim()

  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** An http(s) address with no credentials in it, or null. */
function address(value: unknown): string | null {
  if (typeof value !== "string" || value.length > WEB_SEARCH_MAX_URL_CHARS) {
    return null
  }

  try {
    const url = new URL(value.trim())

    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function dateText(value: unknown): string | undefined {
  const text = plain(value, 40)

  return text || undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** One result, or null when it has no usable address. */
function result(
  title: unknown,
  url: unknown,
  snippet: unknown,
  published?: unknown,
): SearchResult | null {
  const where = address(url)

  if (!where) {
    return null
  }

  const date = dateText(published)

  return {
    title: plain(title, WEB_SEARCH_MAX_TITLE_CHARS) || where,
    url: where,
    snippet: plain(snippet, WEB_SEARCH_MAX_SNIPPET_CHARS),
    ...(date ? { published: date } : {}),
  }
}

/** The results in a provider's JSON answer; null when it is not an answer. */
export function readResults(
  provider: WebSearchProvider,
  body: unknown,
  limit: number,
): SearchResult[] | null {
  const root = record(body)
  let rows: SearchResult[] | null

  switch (provider) {
    case "brave":
      if (!("web" in root) && !("query" in root)) return null
      rows = list(record(root.web).results)
        .map((entry) => {
          const row = record(entry)
          return result(
            row.title,
            row.url,
            row.description,
            row.page_age ?? row.age,
          )
        })
        .filter((row) => row !== null)
      break
    case "tavily":
      if (!Array.isArray(root.results)) return null
      rows = list(root.results)
        .map((entry) => {
          const row = record(entry)
          return result(row.title, row.url, row.content, row.published_date)
        })
        .filter((row) => row !== null)
      break
    case "exa":
      if (!Array.isArray(root.results)) return null
      rows = list(root.results)
        .map((entry) => {
          const row = record(entry)
          const highlights = list(row.highlights)
            .filter((line) => typeof line === "string")
            .join(" … ")

          return result(
            row.title,
            row.url,
            highlights || row.summary || row.text,
            row.publishedDate,
          )
        })
        .filter((row) => row !== null)
      break
    case "serper":
      if (!Array.isArray(root.organic)) return null
      rows = list(root.organic)
        .map((entry) => {
          const row = record(entry)
          return result(row.title, row.link, row.snippet, row.date)
        })
        .filter((row) => row !== null)
      break
    case "searxng":
      if (!Array.isArray(root.results)) return null
      rows = list(root.results)
        .map((entry) => {
          const row = record(entry)
          return result(row.title, row.url, row.content, row.publishedDate)
        })
        .filter((row) => row !== null)
      break
  }

  return rows.slice(0, limit)
}
