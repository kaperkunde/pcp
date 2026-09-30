import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  McpServer,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server"
import { z } from "zod"

import type {
  McpServer as McpServerRow,
  McpTool,
} from "@/lib/generated/prisma/client"

import type { ResolvedToken } from "./api-tokens"
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
  PERMISSION_DECISIONS,
  SECRET_PLACEHOLDER,
  type ToolAccess,
} from "./constants"
import { db } from "./db"
import { isPcpError } from "./errors"
import {
  APP_ONLY_TOOL_META,
  connectResult,
  PANEL_TOOL_META,
  panelResult,
  registerPanelResource,
  type ServerState,
} from "./panel"
import { choosePermissionTier } from "./permission-rules"
import {
  checkPermission,
  decidePermission,
  permissionUrl,
  runCall,
  withPermission,
  type RegisterArgs,
  type ToolRequest,
} from "./permissions"
import { appendRequestLog } from "./request-log"
import { searchTools, summarize, type ToolCandidate } from "./search"
import { findTextSecretByName } from "./secrets"
import { validateServerUrl, type AuthType } from "./servers"
import { effectiveAccess, loadToolAccess } from "./tool-access"
import { needsConnecting, syncServerTools } from "./upstream"

/**
 * The MCP server PCP exposes at /mcp: one per request, built for the token
 * that presented itself. It has a handful of tools instead of the sum of
 * every upstream's, so an assistant's context holds a short summary of what
 * is available and fetches the details of a tool only when it needs them.
 *
 * Each token has a level per tool (lib/core/tool-access.ts): blocked tools
 * are invisible, allowed tools run, and the rest ask the owner first
 * (lib/core/permissions.ts).
 */

export type GatewayScope = ResolvedToken & { publicUrl: string }

export type GatewayTool = McpTool & { access: ToolAccess }

export type GatewayServer = McpServerRow & { tools: GatewayTool[] }

type ToolResult = CallToolResult | InputRequiredResult

export async function loadGatewayServers(
  scope: GatewayScope,
): Promise<GatewayServer[]> {
  const [servers, stored] = await Promise.all([
    db().mcpServer.findMany({
      where: {
        vaultId: scope.ctx.vaultId,
        enabled: true,
        ...(scope.serverIds ? { id: { in: scope.serverIds } } : {}),
      },
      include: { tools: { orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    }),
    loadToolAccess(scope.tokenId),
  ])

  return servers.map((server) => ({
    ...server,
    tools: server.tools.map((tool) => ({
      ...tool,
      access: effectiveAccess(stored, server.id, tool.name),
    })),
  }))
}

/** The tools an assistant with this token may see. */
export function visibleTools(server: GatewayServer): GatewayTool[] {
  return server.tools.filter((tool) => tool.access !== "blocked")
}

export function buildInstructions(servers: GatewayServer[]): string {
  if (servers.length === 0) {
    return "PCP is a gateway to the owner's MCP servers, but this token has no servers to reach yet. Ask the owner to add one in PCP, or propose one with register_server."
  }

  const lines = servers.map((server) => {
    const summary = summarize(server.description || "", 120)
    const count = visibleTools(server).length
    return `- ${server.slug}: ${summary || server.name} (${count} tool${count === 1 ? "" : "s"})`
  })

  return [
    "PCP is a gateway to the owner's MCP servers. Tool names are not listed here: call search_tools with a few words about what you need, then describe_tool for the exact input schema, then call_tool to run it. Refer to tools as server/tool.",
    'The owner decides per tool what you may run. A tool they have not allowed yet answers "Not done yet" with a link: pass it on, and call check_permission with the id it gives for the result. A server that needs them to sign in answers with a link to connect it; check_server says when it is connected. register_server adds a server once the owner agrees.',
    "Servers:",
    ...lines,
  ].join("\n")
}

function candidates(servers: GatewayServer[]): ToolCandidate[] {
  return servers.flatMap((server) =>
    visibleTools(server).map((tool) => ({
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

/** The parts of the SDK's request context the permission step reads. */
function toolRequest(ctx: ServerContext | undefined): ToolRequest {
  const mcpReq = ctx?.mcpReq
  const envelope = mcpReq?.envelope as Record<string, unknown> | undefined
  const state = mcpReq?.requestState?.()

  return {
    clientCapabilities: envelope?.[CLIENT_CAPABILITIES_META_KEY] as
      ClientCapabilities | undefined,
    inputResponses: mcpReq?.inputResponses,
    requestState: typeof state === "string" ? state : undefined,
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/

export function buildGatewayServer(
  scope: GatewayScope,
  servers: GatewayServer[],
): McpServer {
  const server = new McpServer(
    { name: "pcp", title: "PCP", version: "0.2.0" },
    { instructions: buildInstructions(servers) },
  )

  const slugs = servers.map((entry) => entry.slug)
  const bySlug = new Map(servers.map((entry) => [entry.slug, entry]))

  const logged =
    (
      tool: string,
      extra: (args: unknown) => { server?: string; upstreamTool?: string },
    ) =>
    (run: (args: never, ctx: ServerContext) => Promise<ToolResult>) =>
    async (args: unknown, ctx: ServerContext): Promise<ToolResult> => {
      const started = Date.now()
      let result: ToolResult

      try {
        result = await run(args as never, ctx)
      } catch (error) {
        const message = isPcpError(error)
          ? error.message
          : "Something went wrong inside PCP."

        if (!isPcpError(error)) {
          console.error("[gateway] tool failed", { tool, error })
        }

        result = failure(message)
      }

      // A prompt for the owner is not an answer yet; the retry that carries
      // their answer is logged on its own.
      const failed = !isInputRequiredResult(result) && result.isError === true
      const firstText =
        !isInputRequiredResult(result) && result.content[0]?.type === "text"
          ? result.content[0].text
          : ""

      void appendRequestLog({
        vaultId: scope.ctx.vaultId,
        tokenId: scope.tokenId,
        tool,
        ...extra(args),
        ok: !failed,
        ms: Date.now() - started,
        ...(failed ? { error: String(firstText).slice(0, 200) } : {}),
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
            servers.every((entry) => visibleTools(entry).length === 0)
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
        'The full description and JSON Schema of a tool\'s arguments, and whether it runs at once ("allowed") or asks the owner first ("ask"). Call this before call_tool.',
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

      const described = JSON.stringify(
        {
          server: args.server,
          tool: tool.name,
          title: tool.title ?? undefined,
          description: tool.descriptionOverride ?? tool.description,
          access: tool.access,
          inputSchema,
          annotations,
        },
        null,
        1,
      )

      return text(
        described.length > 60_000
          ? `${described.slice(0, 60_000)}\n… (truncated by PCP)`
          : described,
      )
    }),
  )

  server.registerTool(
    "call_tool",
    {
      title: "Call a tool",
      description:
        'Run a tool on one of the owner\'s MCP servers with the arguments its schema asks for. PCP adds the credentials; you never see them. A tool the owner has not allowed yet answers "Not done yet" and waits for their answer.',
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
      async (
        args: {
          server: string
          tool: string
          arguments?: Record<string, unknown>
        },
        ctx,
      ) => {
        const found = findTool(bySlug, args.server, args.tool, {
          includeBlocked: true,
        })

        if ("error" in found) {
          return failure(found.error)
        }

        const { server: target, tool } = found

        if (tool.access === "blocked") {
          return failure(
            `The owner has blocked ${target.slug}/${tool.name} for this token.`,
          )
        }

        const request = toolRequest(ctx)

        // A retry carrying requestState answers a prompt this server issued,
        // even when the owner has since allowed the tool: it must not run
        // the call a second time.
        if (tool.access === "ask" || request.requestState !== undefined) {
          return withPermission(
            scope,
            {
              kind: "call",
              server: target,
              tool,
              args: args.arguments ?? {},
            },
            request,
          )
        }

        return runCall(
          scope.ctx,
          target,
          tool.name,
          args.arguments ?? {},
          scope.publicUrl,
        )
      },
    ),
  )

  server.registerTool(
    "check_permission",
    {
      title: "Check a permission request",
      description:
        "Whether the owner answered a request that was waiting for them, and how it went. Takes the id from the result that asked. While it is still waiting, clients that show panels give the owner the buttons to answer.",
      inputSchema: z.object({
        id: z.string().min(1).max(64).describe("The request's id."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: PANEL_TOOL_META,
    },
    logged("check_permission", () => ({}))(async (args: { id: string }) =>
      checkPermission(scope, args.id),
    ),
  )

  server.registerTool(
    "answer_permission",
    {
      title: "Answer a permission request",
      description:
        "Used by PCP's panel when the owner presses a button. Not for assistants: an assistant cannot answer for the owner.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        decision: z.enum(PERMISSION_DECISIONS),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: APP_ONLY_TOOL_META,
    },
    logged("answer_permission", () => ({}))(
      async (
        args: { id: string; decision: (typeof PERMISSION_DECISIONS)[number] },
        ctx,
      ) => {
        // Hosts that show panels hide this tool from the assistant. A client
        // that did not say it shows panels may list it to the assistant, so
        // the answer has to come from the owner in PCP instead.
        if (
          choosePermissionTier(toolRequest(ctx).clientCapabilities) !== "app"
        ) {
          return failure(
            `This app did not say it shows PCP's panel, so the owner answers in PCP: ${permissionUrl(scope.publicUrl, args.id)}`,
          )
        }

        return decidePermission(scope.ctx, args.id, args.decision, {
          via: "app",
          publicUrl: scope.publicUrl,
          tokenId: scope.tokenId,
        })
      },
    ),
  )

  server.registerTool(
    "check_server",
    {
      title: "Check a server",
      description:
        "Whether one of the owner's servers is connected and how many tools it has. For a server that needs the owner to sign in, clients that show panels give the owner a Connect button.",
      inputSchema: z.object({
        server: z
          .string()
          .describe("The server's short name, as in the list of servers."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: PANEL_TOOL_META,
    },
    logged("check_server", (args) => ({
      server: (args as { server?: string }).server,
    }))(async (args: { server: string }) => {
      const row = await db().mcpServer.findFirst({
        where: {
          vaultId: scope.ctx.vaultId,
          slug: args.server,
          ...(scope.serverIds ? { id: { in: scope.serverIds } } : {}),
        },
        include: { _count: { select: { tools: true } } },
      })

      if (!row) {
        return failure(
          `No server called ${args.server}. Servers: ${slugs.join(", ") || "(none)"}.`,
        )
      }

      const state: ServerState = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        connected: !needsConnecting(row),
        status: row.status,
        toolCount: row._count.tools,
      }

      if (!state.connected) {
        return connectResult(row, scope.publicUrl, {
          lead: "Not connected yet",
          state,
        })
      }

      const said = `${row.name} is connected, with ${state.toolCount} tool${state.toolCount === 1 ? "" : "s"}.${row.enabled ? "" : " The owner has switched it off in PCP."}${row.status === "error" && row.statusMessage ? ` Last contact failed: ${row.statusMessage}` : ""}`

      return panelResult(said, { kind: "done", text: said, server: state })
    }),
  )

  server.registerTool(
    "register_server",
    {
      title: "Add a server",
      description:
        "Propose a new MCP server for PCP to reach, by its address. The owner must agree before it is added. Authentication is none, OAuth (the owner signs in once they agree), or a header carrying a secret the owner already stored in PCP, named by its NAME. Never pass a secret's value: PCP does not take one here.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(80)
          .describe('What to call the server, e.g. "Linear".'),
        url: z
          .string()
          .describe(
            "The server's MCP endpoint, like https://mcp.example.com/mcp.",
          ),
        description: z
          .string()
          .max(1000)
          .optional()
          .describe("One sentence on what it is for; assistants see it."),
        auth_type: z
          .enum(["none", "oauth", "header"])
          .describe(
            "none; oauth (the owner signs in after agreeing); or header (sends a secret the owner stored in PCP).",
          ),
        secret: z
          .string()
          .optional()
          .describe(
            "For header: the name of a secret the owner stored in PCP. Its name, never its value.",
          ),
        header_name: z
          .string()
          .optional()
          .describe(
            `For header: the header to send (default ${DEFAULT_HEADER_NAME}).`,
          ),
        value_template: z
          .string()
          .optional()
          .describe(
            `For header: the header's value with ${SECRET_PLACEHOLDER} where the secret goes (default "${DEFAULT_VALUE_TEMPLATE}").`,
          ),
        oauth_scope: z
          .string()
          .optional()
          .describe(
            "For oauth: the scope to ask for, when the server needs one.",
          ),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: PANEL_TOOL_META,
    },
    logged("register_server", () => ({}))(
      async (
        args: {
          name: string
          url: string
          description?: string
          auth_type: AuthType
          secret?: string
          header_name?: string
          value_template?: string
          oauth_scope?: string
        },
        ctx,
      ) => {
        const url = validateServerUrl(args.url)
        let authSecretId: string | null = null
        let secretName: string | null = null
        let authHeaderName: string | null = null
        let authValueTemplate: string | null = null

        if (args.auth_type === "header") {
          if (!args.secret?.trim()) {
            return failure(
              "Header authentication needs the name of a secret the owner stored in PCP, in secret.",
            )
          }

          const secret = await findTextSecretByName(scope.ctx, args.secret)

          if (!secret) {
            return failure(
              `No secret called "${args.secret.trim()}". The owner can add one in PCP; then ask again with its name.`,
            )
          }

          authSecretId = secret.id
          secretName = secret.name
          authHeaderName = args.header_name?.trim() || DEFAULT_HEADER_NAME
          authValueTemplate =
            args.value_template?.trim() || DEFAULT_VALUE_TEMPLATE

          if (!HEADER_NAME.test(authHeaderName)) {
            return failure("Header names use letters, digits and dashes only.")
          }

          if (
            !authValueTemplate.includes(SECRET_PLACEHOLDER) ||
            /[\r\n]/.test(authValueTemplate)
          ) {
            return failure(
              `The header value must be one line containing ${SECRET_PLACEHOLDER}.`,
            )
          }
        }

        const input: RegisterArgs = {
          name: args.name.trim(),
          url,
          description: args.description?.trim() ?? "",
          authType: args.auth_type,
          authHeaderName,
          authValueTemplate,
          authSecretId,
          oauthScope:
            args.auth_type === "oauth"
              ? args.oauth_scope?.trim() || null
              : null,
          secretName,
        }

        return withPermission(
          scope,
          { kind: "register", input },
          toolRequest(ctx),
          { toolShowsPanel: true },
        )
      },
    ),
  )

  registerPanelResource(server)

  return server
}

function findTool(
  bySlug: Map<string, GatewayServer>,
  slug: string,
  name: string,
  { includeBlocked = false }: { includeBlocked?: boolean } = {},
): { server: GatewayServer; tool: GatewayTool } | { error: string } {
  const server = bySlug.get(slug)

  if (!server) {
    return {
      error: `No server called ${slug}. Servers: ${[...bySlug.keys()].join(", ") || "(none)"}.`,
    }
  }

  const tool = server.tools.find(
    (entry) =>
      entry.name === name && (includeBlocked || entry.access !== "blocked"),
  )

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
