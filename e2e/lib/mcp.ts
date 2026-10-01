export type McpResponse = {
  status: number
  wwwAuthenticate: string | null
  body: {
    result?: {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
      tools?: Array<{
        name: string
        title?: string
        description?: string
        annotations?: { readOnlyHint?: boolean }
        _meta?: { ui?: { resourceUri?: string; visibility?: string[] } }
      }>
      contents?: Array<{ uri: string; mimeType?: string; text?: string }>
      // What PCP says in fields as well as text (lib/core/connect.ts).
      structuredContent?: {
        kind?: string
        permission?: {
          id: string
          status: string
          url: string
          decisions: Array<{ value: string; label: string }>
        }
        connect?: {
          serverId: string
          slug: string
          startUrl: string
        }
        server?: { connected: boolean; toolCount: number }
      }
      // A prompt for the owner (2026-07-28 multi-round-trip results), which
      // PCP never sends.
      resultType?: string
      requestState?: string
      inputRequests?: Record<string, { method: string; params: unknown }>
    } & Record<string, unknown>
    error?: { message: string }
  }
}

/** One JSON-RPC request to /mcp (Streamable HTTP, stateless). */
export async function mcpRequest(
  baseURL: string,
  token: string | null,
  method: string,
  params: unknown = {},
): Promise<McpResponse> {
  const response = await fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })

  return parseResponse(response)
}

async function parseResponse(response: Response): Promise<McpResponse> {
  const text = await response.text()
  const json = text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}")

  return {
    status: response.status,
    wwwAuthenticate: response.headers.get("www-authenticate"),
    body: JSON.parse(json),
  }
}

export function toolText(response: McpResponse): string {
  return response.body.result?.content?.[0]?.text ?? ""
}

export async function callTool(
  baseURL: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpResponse> {
  return mcpRequest(baseURL, token, "tools/call", { name, arguments: args })
}

/** Reads the server's `instructions` through the initialize handshake. */
export async function initialize(
  baseURL: string,
  token: string,
): Promise<{ instructions: string; tools: string[] }> {
  const init = await mcpRequest(baseURL, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  })
  const list = await mcpRequest(baseURL, token, "tools/list")

  return {
    instructions: String(init.body.result?.instructions ?? ""),
    tools: (list.body.result?.tools ?? []).map((tool) => tool.name),
  }
}

/**
 * One tools/call on the stateless 2026-07-28 revision: the client's
 * capabilities travel with the request. PCP reads none of them to decide how
 * to ask the owner (always a link, lib/core/permissions.ts); the spec sends
 * them to show that. Ported from plekje's e2e helpers.
 */
export async function mcpToolCall2026(
  baseURL: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  {
    capabilities = {},
    inputResponses,
    requestState,
  }: {
    capabilities?: Record<string, unknown>
    inputResponses?: Record<string, unknown>
    requestState?: string
  } = {},
): Promise<McpResponse> {
  const response = await fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": capabilities,
          "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" },
        },
        ...(inputResponses ? { inputResponses } : {}),
        ...(requestState ? { requestState } : {}),
      },
    }),
  })

  return parseResponse(response)
}
