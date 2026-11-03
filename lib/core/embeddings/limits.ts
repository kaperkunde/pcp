/**
 * Bounds on search's embeddings (lib/core/embeddings/). A provider is the
 * owner's choice and may be slow, down or far away, and search must still
 * answer at once: everything it waits for is bounded here, and what does
 * not make it in time falls back to keywords.
 */

const SECOND = 1_000
const DAY = 24 * 60 * 60 * SECOND

/** The longest search waits for the query's own vector. */
export const EMBED_QUERY_TIMEOUT_MS = 4 * SECOND

/**
 * The longest search waits for the vectors of items not embedded yet.
 * What is not back by then is ranked by keywords this time, and embedded by
 * a later search.
 */
export const EMBED_ITEMS_TIMEOUT_MS = 8 * SECOND

/** Texts sent in one request to the provider. */
export const EMBED_BATCH_SIZE = 64

/**
 * Items embedded in one search at most: a vault with hundreds of tools is
 * embedded over a few searches, not in one long wait.
 */
export const EMBED_MAX_NEW_PER_SEARCH = 128

/** Characters of one item's text that are embedded; the rest is cut. */
export const EMBED_MAX_TEXT_CHARS = 2_000

/** Characters of a query that are embedded. */
export const EMBED_MAX_QUERY_CHARS = 500

/** The largest answer read from a provider. */
export const EMBED_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** The most dimensions a vector may have. */
export const EMBED_MAX_DIMENSIONS = 8_192

/** Items search ranks by their vectors at most, of each kind together. */
export const EMBED_MAX_ITEMS = 2_000

/**
 * A vector no search used for this long is removed by the cleanup: its
 * text changed, the item is gone, or the provider is another.
 */
export const EMBED_STALE_MS = 30 * DAY

/** How rarely a vector's last use is written, so a search writes little. */
export const EMBED_TOUCH_MS = DAY

/** The model name and an address as the owner may type them. */
export const EMBED_MAX_MODEL_CHARS = 200
export const EMBED_MAX_URL_CHARS = 500

/**
 * The longest an embeddings request waits for its turn under pacing
 * (pacing/index.ts paceEmbeddings) before search goes on with keywords.
 */
export const EMBED_PACE_WAIT_MS = 2 * SECOND
