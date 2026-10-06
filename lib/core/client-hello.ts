/**
 * What a client says about itself when it opens a connection (MCP's
 * `initialize`): its name and version, the protocol revision, the
 * capabilities it declares, and the request's user agent and header names.
 * Logged so the owner can see which app is on the other end (Claude's chat,
 * Cowork, Claude Code), which is how PCP finds out what it can tell them
 * apart by. Header values other than the user agent and the protocol version
 * are never kept: the authorization header is among them.
 */

export type ClientHello = {
  client: { name?: string; title?: string; version?: string }
  protocolVersion?: string
  /** The capability names the client declares, with the names under each. */
  capabilities: Record<string, string[]>
  userAgent?: string
  /** Header names only, sorted. */
  headers: string[]
}

const MAX_TEXT = 200
const MAX_NAMES = 40

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : undefined
}

function names(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
        .slice(0, MAX_NAMES)
        .map((name) => name.slice(0, MAX_TEXT))
    : []
}

/**
 * The hello in a request's JSON-RPC body, or null when the body is not an
 * `initialize` request.
 */
export function clientHello(
  body: string,
  headers: Headers,
): ClientHello | null {
  let message: unknown

  try {
    message = JSON.parse(body)
  } catch {
    return null
  }

  if (
    !message ||
    typeof message !== "object" ||
    (message as { method?: unknown }).method !== "initialize"
  ) {
    return null
  }

  const params = (message as { params?: Record<string, unknown> }).params ?? {}
  const info = (params.clientInfo ?? {}) as Record<string, unknown>
  const declared = params.capabilities
  const capabilities: Record<string, string[]> = {}

  for (const name of names(declared)) {
    capabilities[name] = names((declared as Record<string, unknown>)[name])
  }

  return {
    client: {
      name: text(info.name),
      title: text(info.title),
      version: text(info.version),
    },
    protocolVersion: text(params.protocolVersion),
    capabilities,
    userAgent: text(headers.get("user-agent") ?? undefined),
    headers: [...headers.keys()].sort().slice(0, MAX_NAMES),
  }
}
