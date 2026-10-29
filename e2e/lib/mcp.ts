export type McpResponse = {
  status: number
  wwwAuthenticate: string | null
  body: {
    result?: {
      content?: Array<{ type: string; text?: string; uri?: string }>
      isError?: boolean
      tools?: Array<{
        name: string
        title?: string
        description?: string
        annotations?: { readOnlyHint?: boolean }
        _meta?: { ui?: { resourceUri?: string; visibility?: string[] } }
      }>
      contents?: Array<{
        uri: string
        mimeType?: string
        text?: string
        blob?: string
      }>
      serverInfo?: {
        name: string
        icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>
      }
      // What PCP says in fields as well as text (lib/core/connect.ts).
      structuredContent?: {
        kind?: string
        reason?: string
        request?: string
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

/** Every text block of a result: a notice (a kept answer's) is a block of its own. */
export function allToolText(response: McpResponse): string {
  return (response.body.result?.content ?? [])
    .map((block) => block.text ?? "")
    .join("\n")
}

/** The last text block of a tool's answer: its JSON, after any notes. */
export function lastToolText(response: McpResponse): string {
  return (
    (response.body.result?.content ?? [])
      .filter((block) => block.type === "text")
      .at(-1)?.text ?? ""
  )
}

/** The gateway's tools that take a call_handle rather than a name. */
const HANDLED = new Set(["call_tool", "call_read_only_tool"])

/**
 * The call_handle describe gives for server/tool, or describe's
 * answer when it gives none (no such tool, or one the token cannot see).
 */
export async function describeForCall(
  baseURL: string,
  token: string,
  server: string,
  tool: string,
): Promise<{ handle: string } | { refused: McpResponse }> {
  const described = await mcpRequest(baseURL, token, "tools/call", {
    name: "describe",
    arguments: { server, tool },
  })

  if (described.body.result?.isError || !described.body.result) {
    return { refused: described }
  }

  return {
    handle: (JSON.parse(toolText(described)) as { call_handle: string })
      .call_handle,
  }
}

/**
 * A tool's arguments as an assistant sends them: call_tool and
 * call_read_only_tool written with a server and a tool name describe the
 * tool first and pass its call_handle in their place, as the gateway's
 * instructions say. When describe refuses, its answer is the result.
 */
async function withHandle(
  baseURL: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | McpResponse> {
  const { server, tool, ...rest } = args

  if (
    !HANDLED.has(name) ||
    typeof server !== "string" ||
    typeof tool !== "string"
  ) {
    return args
  }

  const described = await describeForCall(baseURL, token, server, tool)

  return "refused" in described
    ? described.refused
    : { call_handle: described.handle, ...rest }
}

function isResponse(
  value: Record<string, unknown> | McpResponse,
): value is McpResponse {
  return "status" in value && "body" in value
}

export async function callTool(
  baseURL: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpResponse> {
  const sent = await withHandle(baseURL, token, name, args)

  return isResponse(sent)
    ? sent
    : mcpRequest(baseURL, token, "tools/call", { name, arguments: sent })
}

/** Reads the server's `instructions` through the initialize handshake. */
export async function initialize(
  baseURL: string,
  token: string,
): Promise<{
  instructions: string
  tools: string[]
  serverInfo: NonNullable<McpResponse["body"]["result"]>["serverInfo"]
}> {
  const init = await mcpRequest(baseURL, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  })
  const list = await mcpRequest(baseURL, token, "tools/list")

  return {
    instructions: String(init.body.result?.instructions ?? ""),
    tools: (list.body.result?.tools ?? []).map((tool) => tool.name),
    serverInfo: init.body.result?.serverInfo,
  }
}

/**
 * One tools/call on the stateless 2026-07-28 revision: the client's
 * capabilities travel with the request. PCP reads none of them to decide how
 * to ask the owner (always a link, lib/core/permissions.ts); the spec sends
 * them to show that.
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
  const sent = await withHandle(baseURL, token, name, args)

  if (isResponse(sent)) {
    return sent
  }

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
        arguments: sent,
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
