import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import type {
  McpServer as McpServerRow,
  McpTool,
} from "@/lib/generated/prisma/client"

import type { ResolvedToken } from "./api-tokens"
import { db } from "./db"
import {
  getEndpoint,
  registerEndpoint,
  updateEndpointDetails,
} from "./endpoint-admin"
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

const MANAGE_INSTRUCTIONS =
  "This token can also add and maintain API endpoints: register_endpoint takes OpenAPI 3 text (JSON or YAML; write one from the API's documentation if it has none), update_endpoint changes an endpoint, get_endpoint reads one. You cannot attach a credential; the owner does that in PCP."

export function buildInstructions(
  servers: GatewayServer[],
  { manageEndpoints = false }: { manageEndpoints?: boolean } = {},
): string {
  if (servers.length === 0) {
    return [
      "PCP is a gateway to the owner's MCP servers, but this token has no servers to reach yet. Ask the owner to add one in PCP.",
      ...(manageEndpoints ? [MANAGE_INSTRUCTIONS] : []),
    ].join("\n")
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
    ...(manageEndpoints ? [MANAGE_INSTRUCTIONS] : []),
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
    {
      instructions: buildInstructions(servers, {
        manageEndpoints: scope.manageEndpoints,
      }),
    },
  )

  const slugs = servers.map((entry) => entry.slug)
  const bySlug = new Map(servers.map((entry) => [entry.slug, entry]))

  // Results an upstream wrote (an API's error body, an MCP tool's error
  // text). The log says that a call failed, never what the upstream said.
  const fromUpstream = new WeakSet<CallToolResult>()

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
              error: fromUpstream.has(result)
                ? "The tool reported an error."
                : String(
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

        const answer: CallToolResult = {
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

        if (answer.isError) {
          fromUpstream.add(answer)
        }

        return answer
      },
    ),
  )

  // Only for a token the owner made with "add and change API endpoints":
  // an assistant that can register endpoints decides where PCP sends
  // requests, so it is never on by default. What these tools may do is
  // decided in endpoint-admin.ts.
  if (scope.manageEndpoints) {
    const json = (value: unknown) => text(clip(JSON.stringify(value, null, 1)))
    const slugOf = (args: unknown) => ({
      server: (args as { endpoint?: string }).endpoint,
    })

    server.registerTool(
      "register_endpoint",
      {
        title: "Register an API endpoint",
        description:
          "Add an API to the owner's PCP from an OpenAPI 3 document, given as text (JSON or YAML). If the API has no OpenAPI document, write one from its documentation. Each operation becomes a tool: find it with search_tools, run it with call_tool. The endpoint sends no credential (the owner attaches a secret in PCP if the API needs one) and refuses private addresses until the owner allows them.",
        inputSchema: z.object({
          name: z.string().min(1).max(80).describe("A name for the API."),
          spec: z
            .string()
            .min(1)
            .describe("The OpenAPI 3 document, as JSON or YAML text."),
          baseUrl: z
            .string()
            .optional()
            .describe(
              "Where the API lives, e.g. https://api.example.com/v1. Needed when the document's servers entry is missing or relative.",
            ),
          description: z
            .string()
            .max(1000)
            .optional()
            .describe(
              "What the API is for, in a sentence or two; other assistants read it when searching.",
            ),
          readOnly: z
            .boolean()
            .optional()
            .describe("Offer only GET operations."),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      logged("register_endpoint", () => ({}))(
        async (args: {
          name: string
          spec: string
          baseUrl?: string
          description?: string
          readOnly?: boolean
        }) => json(await registerEndpoint(scope, args)),
      ),
    )

    server.registerTool(
      "update_endpoint",
      {
        title: "Change an API endpoint",
        description:
          "Change an API endpoint: its name, description, OpenAPI document (when it was added as text), base URL, read-only setting, or the descriptions of its tools. Pass only what changes. Some changes are the owner's alone, and get_endpoint says which; you can never change the credential, and you cannot move an endpoint that sends a secret.",
        inputSchema: z.object({
          endpoint: z
            .string()
            .describe("The endpoint's short name, as in server/tool."),
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(1000).optional(),
          spec: z
            .string()
            .min(1)
            .optional()
            .describe(
              "A whole new OpenAPI 3 document as JSON or YAML text; it replaces the old one, and tools are rebuilt from it.",
            ),
          baseUrl: z.string().optional(),
          readOnly: z.boolean().optional(),
          toolDescriptions: z
            .record(z.string(), z.string().max(2000).nullable())
            .optional()
            .describe(
              "Tool name to a better description for assistants; null goes back to the schema's own.",
            ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      logged(
        "update_endpoint",
        slugOf,
      )(async (args: { endpoint: string } & Record<string, unknown>) => {
        const { endpoint, ...changes } = args
        return json(await updateEndpointDetails(scope, endpoint, changes))
      }),
    )

    server.registerTool(
      "get_endpoint",
      {
        title: "Read an API endpoint",
        description:
          "An API endpoint's settings, its tools, what you may change on it, and (with includeSpec) the OpenAPI text it was built from, so you can edit it and send it back with update_endpoint. Never includes a secret.",
        inputSchema: z.object({
          endpoint: z
            .string()
            .describe("The endpoint's short name, as in server/tool."),
          includeSpec: z
            .boolean()
            .optional()
            .describe("Also return the stored OpenAPI text, if not too long."),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      logged(
        "get_endpoint",
        slugOf,
      )(async (args: { endpoint: string; includeSpec?: boolean }) =>
        json(
          await getEndpoint(scope, args.endpoint, {
            includeSpec: args.includeSpec,
          }),
        ),
      ),
    )
  }

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
