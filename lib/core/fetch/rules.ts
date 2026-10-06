import {
  DEFAULT_TOOL_ACCESS,
  FETCH_METHOD_GROUPS,
  type FetchMethodGroup,
  type FetchSiteLevel,
  type ToolAccess,
} from "../constants"
import { invalid } from "../errors"
import { MAX_SITE_LENGTH } from "./limits"

/**
 * Which level a web_fetch request gets, kept free of the database so it can
 * be tested on its own (lib/core/web-fetch.ts stores the levels).
 *
 * A request is one method to one site. The site's level decides when it has
 * one; otherwise the method's does; otherwise PCP asks. At each step the
 * token's own level wins over the one for all tokens, and a token's own site
 * set to "Use the method settings" goes straight to the methods: the line
 * for this token is what it says, even where all tokens have another.
 *
 * Private addresses (loopback, private and link-local ranges: the owner's
 * own network) are a line of their own, allowed or blocked and never asked
 * about: blocked unless the owner allowed them for the token or for all
 * tokens, the token's own line winning.
 */

export type FetchRuleSet = {
  ownMethods: Map<FetchMethodGroup, ToolAccess>
  sharedMethods: Map<FetchMethodGroup, ToolAccess>
  /** null: the site follows the method levels. */
  ownSites: Map<string, ToolAccess | null>
  sharedSites: Map<string, ToolAccess | null>
  /** null: no line, so private addresses stay blocked. */
  ownPrivate: ToolAccess | null
  sharedPrivate: ToolAccess | null
}

export type FetchDecision = {
  access: ToolAccess
  /** What decided it, for the refusal an assistant reads. */
  by: "site" | "method" | "default"
}

/** RFC 9110 token characters: what a method name may contain. */
const METHOD = /^[A-Z0-9!#$%&'*+.^_`|~-]{1,20}$/
/** A tunnel and a request echoed back: neither is fetching a page. */
const REFUSED_METHODS = new Set(["CONNECT", "TRACE"])

export function emptyRules(): FetchRuleSet {
  return {
    ownMethods: new Map(),
    sharedMethods: new Map(),
    ownSites: new Map(),
    sharedSites: new Map(),
    ownPrivate: null,
    sharedPrivate: null,
  }
}

/** The method as it is sent: upper-case, GET when none is given. */
export function normalizeMethod(raw: string | undefined): string {
  const method = (raw ?? "").trim().toUpperCase() || "GET"

  if (!METHOD.test(method)) {
    throw invalid("The method must be a name like GET or POST.")
  }

  if (REFUSED_METHODS.has(method)) {
    throw invalid(`web_fetch does not send ${method} requests.`)
  }

  return method
}

export function methodGroup(method: string): FetchMethodGroup {
  return method !== "OTHER" &&
    (FETCH_METHOD_GROUPS as readonly string[]).includes(method)
    ? (method as FetchMethodGroup)
    : "OTHER"
}

export function isMethodGroup(value: string): value is FetchMethodGroup {
  return (FETCH_METHOD_GROUPS as readonly string[]).includes(value)
}

/**
 * What a site is: the host, with the port when it is not the scheme's own.
 * http and https on one host are one site; a subdomain is a site of its own.
 */
export function siteKey(url: URL): string {
  return url.host.toLowerCase()
}

/** A site as the owner types it: example.com, or a whole address. */
export function normalizeSite(input: string): string {
  const trimmed = input.trim()

  if (!trimmed) {
    throw invalid("Enter a site, like example.com.")
  }

  if (trimmed.length > MAX_SITE_LENGTH) {
    throw invalid(`Keep the site under ${MAX_SITE_LENGTH} characters.`)
  }

  let url: URL

  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    )
  } catch {
    throw invalid("Enter a site, like example.com or https://example.com.")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid("A site is an http:// or https:// address.")
  }

  if (url.username || url.password) {
    throw invalid("Leave the user name and password out of the site.")
  }

  if (!url.hostname || url.hostname.includes("*")) {
    throw invalid(
      "A site is one host, like example.com; there are no wildcards.",
    )
  }

  return siteKey(url)
}

export function toSiteLevel(access: ToolAccess | null): FetchSiteLevel {
  return access ?? "default"
}

export function fromSiteLevel(level: FetchSiteLevel): ToolAccess | null {
  return level === "default" ? null : level
}

/** The level of one site, when it has one: the token's own row, else all tokens'. */
function siteAccess(rules: FetchRuleSet, host: string): ToolAccess | null {
  if (rules.ownSites.has(host)) {
    return rules.ownSites.get(host) ?? null
  }

  return rules.sharedSites.get(host) ?? null
}

export function resolveFetchAccess(
  rules: FetchRuleSet,
  host: string,
  group: FetchMethodGroup,
): FetchDecision {
  const site = siteAccess(rules, host)

  if (site) {
    return { access: site, by: "site" }
  }

  const method = rules.ownMethods.get(group) ?? rules.sharedMethods.get(group)

  if (method) {
    return { access: method, by: "method" }
  }

  return { access: DEFAULT_TOOL_ACCESS, by: "default" }
}

/** Whether a token already has a line for a site, its own or all tokens'. */
export function knowsSite(rules: FetchRuleSet, host: string): boolean {
  return rules.ownSites.has(host) || rules.sharedSites.has(host)
}

/**
 * Whether requests may reach private addresses: the token's own line, else
 * the one for all tokens, else no. Only "allowed" allows; there is no
 * asking, because the address is known only once the name is looked up,
 * after the owner would have been asked about the site.
 */
export function resolvePrivateAccess(rules: FetchRuleSet): boolean {
  return (rules.ownPrivate ?? rules.sharedPrivate) === "allowed"
}
