/**
 * Bounds on web_search (lib/core/websearch/). A provider is the owner's
 * choice and may be slow, down or dear, and an assistant may ask often:
 * everything is bounded here, nothing by site or vendor name.
 */

const SECOND = 1_000
const MINUTE = 60 * SECOND

/** The longest query, in characters. */
export const WEB_SEARCH_MAX_QUERY_CHARS = 400

/** Results asked for when the call does not say. */
export const WEB_SEARCH_DEFAULT_LIMIT = 10

/** The most results one call asks for. */
export const WEB_SEARCH_MAX_LIMIT = 20

/** The longest a call waits for the provider. */
export const WEB_SEARCH_TIMEOUT_MS = 15 * SECOND

/** The largest answer read from a provider. */
export const WEB_SEARCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** How long an answer is kept in memory for the same search again. */
export const WEB_SEARCH_CACHE_TTL_MS = 5 * MINUTE

/** The most answers kept in memory, over every vault; the oldest go first. */
export const WEB_SEARCH_CACHE_MAX = 200

/** Characters of a result's title and snippet that are passed on. */
export const WEB_SEARCH_MAX_TITLE_CHARS = 300
export const WEB_SEARCH_MAX_SNIPPET_CHARS = 600
export const WEB_SEARCH_MAX_URL_CHARS = 2_000

/** web_search calls per token in a short time, as web_fetch's are counted. */
export const WEB_SEARCHES = { max: 60, windowMs: 10 * MINUTE }

/** The longest address of a self-hosted search the owner types. */
export const WEB_SEARCH_MAX_URL_SETTING_CHARS = 500
