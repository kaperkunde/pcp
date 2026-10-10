/**
 * What a client says about itself: when it opens a connection (MCP's
 * `initialize`), and on every request under protocol revision 2026-07-28,
 * which has no `initialize` and carries the client's info, capabilities and
 * protocol version in each request's `_meta` instead. Logged so the owner
 * can see which app is on the other end (Claude's chat, Cowork, Claude
 * Code), which is how PCP finds out what it can tell them apart by. Of the
 * headers only the names are kept, and the values of the few that label the
 * client (`LABEL_HEADERS`): never the authorization header's.
 */

export type ClientInfo = { name?: string; title?: string; version?: string }

export type ClientHello = {
  client: ClientInfo
  protocolVersion?: string
  /** The capability names the client declares, with the names under each. */
  capabilities: Record<string, string[]>
  userAgent?: string
  /** Header names only, sorted. */
  headers: string[]
}

const MAX_TEXT = 200
const MAX_NAMES = 40

/** Headers whose values name the client, and are kept. */
const LABEL_HEADERS = ["mcp-protocol-version", "x-anthropic-client"]

const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion"
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo"
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function names(value: unknown): string[] {
  return isObject(value)
    ? Object.keys(value)
        .slice(0, MAX_NAMES)
        .map((name) => name.slice(0, MAX_TEXT))
    : []
}

function clientInfo(value: unknown): ClientInfo {
  const info = isObject(value) ? value : {}

  return {
    name: text(info.name),
    title: text(info.title),
    version: text(info.version),
  }
}

function capabilities(declared: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {}

  for (const name of names(declared)) {
    result[name] = names((declared as Record<string, unknown>)[name])
  }

  return result
}

function headerNames(headers: Headers): string[] {
  return [...headers.keys()].sort().slice(0, MAX_NAMES)
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const message: unknown = JSON.parse(body)
    return isObject(message) ? message : null
  } catch {
    return null
  }
}

/**
 * The hello in a request's JSON-RPC body, or null when the body is not an
 * `initialize` request.
 */
export function clientHello(
  body: string,
  headers: Headers,
): ClientHello | null {
  const message = parse(body)

  if (message?.method !== "initialize") {
    return null
  }

  const params = isObject(message.params) ? message.params : {}

  return {
    client: clientInfo(params.clientInfo),
    protocolVersion: text(params.protocolVersion),
    capabilities: capabilities(params.capabilities),
    userAgent: text(headers.get("user-agent") ?? undefined),
    headers: headerNames(headers),
  }
}

/**
 * What a request says about the app sending it, the first time this process
 * sees it from a token: the client named in its `_meta` (2026-07-28), the
 * capabilities and protocol version there, its user agent, the values of the
 * headers that label it, its header names, and the JSON-RPC method it
 * carried. A client that connected before PCP started (Claude's connectors
 * keep calling a stateless server without a new `initialize`) still shows up
 * this way. Null for one seen before.
 */
export type ClientSeen = {
  method?: string
  client?: ClientInfo
  protocolVersion?: string
  capabilities?: Record<string, string[]>
  userAgent?: string
  /** The values of `LABEL_HEADERS` the request carried. */
  labels: Record<string, string>
  headers: string[]
}

const MAX_SEEN = 1_000
const seen = new Set<string>()

export function clientSeen(
  tokenId: string,
  body: string,
  headers: Headers,
): ClientSeen | null {
  const message = parse(body)
  const params = isObject(message?.params) ? message.params : {}
  const meta = isObject(params._meta) ? params._meta : {}
  const labels: Record<string, string> = {}

  for (const name of LABEL_HEADERS) {
    const value = text(headers.get(name) ?? undefined)

    if (value !== undefined) {
      labels[name] = value
    }
  }

  const described: ClientSeen = {
    method: text(message?.method),
    client:
      CLIENT_INFO_META in meta ? clientInfo(meta[CLIENT_INFO_META]) : undefined,
    protocolVersion: text(meta[PROTOCOL_VERSION_META]),
    capabilities:
      CLIENT_CAPABILITIES_META in meta
        ? capabilities(meta[CLIENT_CAPABILITIES_META])
        : undefined,
    userAgent: text(headers.get("user-agent") ?? undefined),
    labels,
    headers: headerNames(headers),
  }
  // The same client sending another method is not new.
  const key = JSON.stringify([tokenId, { ...described, method: undefined }])

  if (seen.has(key)) {
    return null
  }

  // Forget the oldest rather than grow without end.
  if (seen.size >= MAX_SEEN) {
    seen.delete(seen.values().next().value as string)
  }

  seen.add(key)
  return described
}
