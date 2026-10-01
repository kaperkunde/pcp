import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import type {
  McpServer as McpServerRow,
  McpTool,
} from "@/lib/generated/prisma/client"

import type { ResolvedToken } from "./api-tokens"
import { db } from "./db"
import { isPcpError } from "./errors"
import { appendRequestLog } from "./request-log"
import { searchTools, summarize, type ToolCandidate } from "./search"
import { callServerTool, syncServerTools } from "./upstream"

/**
 * The MCP server PCP exposes at /mcp: one per request, built for the token
 * that presented itself. It has three tools instead of the sum of every
 * upstream's, so an assistant's context holds a short summary of what is
 * available and fetches the details of a tool only when it needs them.
 */

export type GatewayScope = ResolvedToken & { publicUrl: string }

export type GatewayServer = McpServerRow & { tools: McpTool[] }

const MAX_RESULT_CHARS = 60_000

export async function loadGatewayServers(
  scope: GatewayScope,
): Promise<GatewayServer[]> {
  return db().mcpServer.findMany({
    where: {
      vaultId: scope.ctx.vaultId,
      enabled: true,
      ...(scope.serverIds ? { id: { in: scope.serverIds } } : {}),
    },
    include: { tools: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  })
}

export function buildInstructions(servers: GatewayServer[]): string {
  if (servers.length === 0) {
    return "PCP is a gateway to the owner's MCP servers, but this token has no servers to reach yet. Ask the owner to add one in PCP."
  }

  const lines = servers.map((server) => {
    const summary = summarize(server.description || "", 120)
    const count = server.tools.length
    return `- ${server.slug}: ${summary || server.name} (${count} tool${count === 1 ? "" : "s"})`
  })

  return [
    "PCP is a gateway to the owner's MCP servers and APIs. Tool names are not listed here: call search_tools with a few words about what you need, then describe_tool for the exact input schema, then call_tool to run it. Refer to tools as server/tool.",
    "Servers:",
    ...lines,
  ].join("\n")
}

function candidates(servers: GatewayServer[]): ToolCandidate[] {
  return servers.flatMap((server) =>
    server.tools.map((tool) => ({
      server: server.slug,
      serverName: server.name,
      serverDescription: server.description,
      name: tool.name,
      title: tool.title,
      description: tool.descriptionOverride ?? tool.description,
    })),
  )
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] }
}

function failure(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }], isError: true }
}

function clip(value: string): string {
  return value.length > MAX_RESULT_CHARS
    ? `${value.slice(0, MAX_RESULT_CHARS)}\n… (truncated by PCP)`
    : value
}

export function buildGatewayServer(
  scope: GatewayScope,
  servers: GatewayServer[],
): McpServer {
  const server = new McpServer(
    { name: "pcp", title: "PCP", version: "0.1.0" },
    { instructions: buildInstructions(servers) },
  )

  const slugs = servers.map((entry) => entry.slug)
  const bySlug = new Map(servers.map((entry) => [entry.slug, entry]))

  const logged =
    (
      tool: string,
      extra: (args: unknown) => { server?: string; upstreamTool?: string },
    ) =>
    (run: (args: never) => Promise<CallToolResult>) =>
    async (args: unknown): Promise<CallToolResult> => {
      const started = Date.now()
      let result: CallToolResult

      try {
        result = await run(args as never)
      } catch (error) {
        const message = isPcpError(error)
          ? error.message
          : "Something went wrong inside PCP."

        if (!isPcpError(error)) {
          console.error("[gateway] tool failed", { tool, error })
        }

        result = failure(message)
      }

      void appendRequestLog({
        vaultId: scope.ctx.vaultId,
        tokenId: scope.tokenId,
        tool,
        ...extra(args),
        ok: !result.isError,
        ms: Date.now() - started,
        ...(result.isError
          ? {
              error: String(
                result.content[0]?.type === "text"
                  ? result.content[0].text
                  : "",
              ).slice(0, 200),
            }
          : {}),
      })

      return result
    }

  const serverArg = z
    .string()
    .optional()
    .describe(
      `Limit to one server: ${slugs.length ? slugs.join(", ") : "(none)"}.`,
    )

  server.registerTool(
    "search_tools",
    {
      title: "Search tools",
      description:
        'Find tools across the owner\'s MCP servers by describing what you want to do (e.g. "create a github issue", "send email"). Returns matching tools as server/tool with a one-line summary; call describe_tool before using one.',
      inputSchema: z.object({
        query: z
          .string()
          .describe("A few words about the task, or part of a tool name."),
        server: serverArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many results (default 10)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged("search_tools", () => ({}))(
      async (args: { query: string; server?: string; limit?: number }) => {
        if (args.server && !bySlug.has(args.server)) {
          return failure(
            `No server called ${args.server}. Servers: ${slugs.join(", ") || "(none)"}.`,
          )
        }

        const matches = searchTools(candidates(servers), args.query, {
          limit: args.limit ?? 10,
          server: args.server,
        })

        if (matches.length === 0) {
          return text(
            servers.every((entry) => entry.tools.length === 0)
              ? "No tools are known yet. The owner can refresh each server's tools in PCP."
              : `No tools match "${args.query}". Try other words, or search with an empty query to list everything.`,
          )
        }

        const lines = matches.map(
          (match) =>
            `${match.server}/${match.name}${match.title ? ` (${match.title})` : ""} — ${summarize(match.description) || "no description"}`,
        )

        return text(lines.join("\n"))
      },
    ),
  )

  server.registerTool(
    "describe_tool",
    {
      title: "Describe a tool",
      description:
        "The full description and JSON Schema of a tool's arguments. Call this before call_tool.",
      inputSchema: z.object({
        server: z.string().describe("The server, as returned by search_tools."),
        tool: z.string().describe("The tool name."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged("describe_tool", (args) => ({
      server: (args as { server?: string }).server,
      upstreamTool: (args as { tool?: string }).tool,
    }))(async (args: { server: string; tool: string }) => {
      const found = findTool(bySlug, args.server, args.tool)

      if ("error" in found) {
        return failure(found.error)
      }

      const { tool } = found
      let inputSchema: unknown
      let annotations: unknown

      try {
        inputSchema = JSON.parse(tool.inputSchema)
        annotations = tool.annotations
          ? JSON.parse(tool.annotations)
          : undefined
      } catch {
        inputSchema = tool.inputSchema
      }

      return text(
        clip(
          JSON.stringify(
            {
              server: args.server,
              tool: tool.name,
              title: tool.title ?? undefined,
              description: tool.descriptionOverride ?? tool.description,
              inputSchema,
              annotations,
            },
            null,
            1,
          ),
        ),
      )
    }),
  )

  server.registerTool(
    "call_tool",
    {
      title: "Call a tool",
      description:
        "Run a tool on one of the owner's MCP servers with the arguments its schema asks for. PCP adds the credentials; you never see them.",
      inputSchema: z.object({
        server: z.string().describe("The server, as returned by search_tools."),
        tool: z.string().describe("The tool name."),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "The tool's arguments, matching describe_tool's inputSchema.",
          ),
      }),
      annotations: { openWorldHint: true },
    },
    logged("call_tool", (args) => ({
      server: (args as { server?: string }).server,
      upstreamTool: (args as { tool?: string }).tool,
    }))(
      async (args: {
        server: string
        tool: string
        arguments?: Record<string, unknown>
      }) => {
        const found = findTool(bySlug, args.server, args.tool)

        if ("error" in found) {
          return failure(found.error)
        }

        const result = await callServerTool(
          scope.ctx,
          found.server,
          found.tool.name,
          args.arguments ?? {},
          { publicUrl: scope.publicUrl },
        )

        return {
          content: result.content.map((block) =>
            block.type === "text"
              ? { ...block, text: clip(block.text) }
              : block,
          ),
          ...(result.isError ? { isError: true } : {}),
          ...(result.structuredContent
            ? { structuredContent: result.structuredContent }
            : {}),
        }
      },
    ),
  )

  return server
}

function findTool(
  bySlug: Map<string, GatewayServer>,
  slug: string,
  name: string,
): { server: GatewayServer; tool: McpTool } | { error: string } {
  const server = bySlug.get(slug)

  if (!server) {
    return {
      error: `No server called ${slug}. Servers: ${[...bySlug.keys()].join(", ") || "(none)"}.`,
    }
  }

  const tool = server.tools.find((entry) => entry.name === name)

  if (!tool) {
    return {
      error: `${slug} has no tool called ${name}. Use search_tools to find the right name.`,
    }
  }

  return { server, tool }
}

/**
 * Reads the catalogue of a server nobody has read yet (added through some
 * other path than the UI, say). Servers that failed before are left to the
 * owner's Refresh: retrying them on every call would slow the gateway down
 * by an upstream timeout each time.
 */
export async function ensureCatalogue(
  scope: GatewayScope,
  servers: GatewayServer[],
): Promise<GatewayServer[]> {
  let refreshed = false

  for (const server of servers) {
    if (server.tools.length === 0 && server.status === "unknown") {
      const result = await syncServerTools(scope.ctx, server, {
        publicUrl: scope.publicUrl,
      })
      refreshed ||= result.status === "ok"
    }
  }

  return refreshed ? loadGatewayServers(scope) : servers
}
