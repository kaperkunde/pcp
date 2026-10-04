/**
 * Where a request came in, and whether it came from PCP's own pages.
 *
 * No `server-only` here: these read a Request's headers and nothing of
 * Next's, so a unit test can call them.
 */

/**
 * The origin a request arrived at: its Host, or what a proxy in front of
 * PCP (or PCP's own HTTPS edge) says in X-Forwarded-*.
 */
export function originFromHeaders(hdrs: Headers): string {
  const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http"
  const host =
    hdrs.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    hdrs.get("host") ||
    "localhost:3000"

  return `${proto}://${host}`
}

/**
 * Whether a request was sent by one of PCP's own pages. Server Actions
 * check this for themselves; a route handler that does anything for the
 * signed-in owner has to, or any site they visit could have their browser
 * send the request with their cookie. Browsers put Sec-Fetch-Site on every
 * request they make, and Origin on every POST; a request with neither is
 * refused rather than trusted.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site")

  if (site !== null) {
    return site === "same-origin"
  }

  const origin = request.headers.get("origin")

  return origin !== null && origin === originFromHeaders(request.headers)
}
