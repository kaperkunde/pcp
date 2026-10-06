/**
 * Where to go on to after signing in, when a page sent the owner to /login
 * first. Only PCP's sign-in page for assistants (/oauth/authorize, with its
 * query) qualifies: the parameter is in a link anyone can send, so it never
 * leads off the site or anywhere else on it.
 */

const AUTHORIZE_PATH = "/oauth/authorize"

export function returnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(`${AUTHORIZE_PATH}?`)) {
    return null
  }

  let url: URL

  try {
    url = new URL(value, "http://pcp.invalid")
  } catch {
    return null
  }

  return url.origin === "http://pcp.invalid" && url.pathname === AUTHORIZE_PATH
    ? `${url.pathname}${url.search}`
    : null
}
