/** Limits of the request log (lib/core/request-log.ts) and its Log page. */

/** Lines on one page of the Log page. */
export const LOG_PAGE_SIZE = 100

/** The most a caller can ask for in one page. */
export const MAX_LOG_PAGE_SIZE = 500

/**
 * Lines read for one page, matching or not, before it stops and hands back
 * where it got to: a filter that matches little reads a few days at a time.
 */
export const LOG_SCAN_LINES = 50_000

/** After a failed write, how long the log waits before trying again. */
export const LOG_RETRY_MS = 5 * 60_000

/** The search box on the Log page. */
export const MAX_LOG_SEARCH_CHARS = 80
