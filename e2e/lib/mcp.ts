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
      }>
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
