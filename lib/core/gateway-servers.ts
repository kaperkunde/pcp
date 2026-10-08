import type {
  McpServer as McpServerRow,
  McpTool,
} from "@/lib/generated/prisma/client"

import { allowanceHolds, loadToolAllowances } from "./allowances"
import type { ResolvedToken } from "./api-tokens"
import type { ToolAccess } from "./constants"
import { db } from "./db"
import { accessKey, effectiveAccess, loadToolAccess } from "./tool-access"
import { readWrapperOperation } from "./wrappers/definition"

/**
 * The servers and tools a token reaches, with its level for each: what the
 * gateway (gateway.ts) serves a request from, and what a wrapper's program
 * calls through (lib/core/wrappers/run.ts).
 */

export type GatewayScope = ResolvedToken & { publicUrl: string }

/**
 * A tool as the gateway keeps it for a request: enough to search and list,
 * and the token's level for it. The schema and the call plan are read when a
 * tool is described or called, so a request does not carry every tool's
 * schema, which for a large endpoint is megabytes.
 */
export type GatewayTool = Pick<
  McpTool,
  "id" | "name" | "title" | "description" | "descriptionOverride"
> & {
  access: ToolAccess
  /**
   * A wrapper's tool this token sees stands in for this one ("wrapper/tool"):
   * left out of search_tools and list_tools, still called by its name.
   */
  hiddenBy?: string
}

export type GatewayServer = McpServerRow & { tools: GatewayTool[] }

const STRICTNESS: Record<ToolAccess, number> = {
  allowed: 0,
  ask: 1,
  blocked: 2,
}

/**
 * The servers a token reaches, each tool with the level its calls get: its
 * levels, with "ask" lifted to "allowed" where the owner allowed the tool
 * for a while (lib/core/allowances.ts) and that time has not run out.
 *
 * A wrapper's tool never reaches further than the token does: its level is
 * the strictest of its own and of every tool it calls (one the token cannot
 * reach counts as blocked), so a wrapper is blocked wherever one of its
 * calls is, and asks wherever one of them asks. The tools a wrapper's tool
 * replaces are hidden from search while that tool is not blocked.
 */
export async function loadGatewayServers(
  scope: Pick<GatewayScope, "ctx" | "tokenId" | "serverIds"> &
    Partial<GatewayScope>,
  now = new Date(),
): Promise<GatewayServer[]> {
  const [servers, stored, allowances] = await Promise.all([
    db().mcpServer.findMany({
      where: {
        vaultId: scope.ctx.vaultId,
        enabled: true,
        ...(scope.serverIds ? { id: { in: scope.serverIds } } : {}),
      },
      include: {
        tools: {
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            title: true,
            description: true,
            descriptionOverride: true,
          },
        },
      },
      orderBy: { name: "asc" },
    }),
    loadToolAccess(scope.ctx.vaultId, scope.tokenId),
    loadToolAllowances(scope.tokenId, now),
  ])

  const loaded: GatewayServer[] = servers.map((server) => ({
    ...server,
    tools: server.tools.map((tool) => {
      const level = effectiveAccess(stored, server.id, tool.name)
      const until = allowances.get(accessKey(server.id, tool.name))

      return {
        ...tool,
        access:
          level === "ask" && allowanceHolds(until, now.getTime())
            ? "allowed"
            : level,
      }
    }),
  }))

  return applyWrappers(loaded)
}

/** A wrapper's tools at the strictest level, and what they hide. */
async function applyWrappers(
  servers: GatewayServer[],
): Promise<GatewayServer[]> {
  const wrappers = servers.filter((server) => server.kind === "wrapper")

  if (wrappers.length === 0) {
    return servers
  }

  const operations = await db().mcpTool.findMany({
    where: { serverId: { in: wrappers.map((server) => server.id) } },
    select: { serverId: true, name: true, operation: true },
  })
  const opOf = new Map(
    operations.map((row) => [
      accessKey(row.serverId, row.name),
      readWrapperOperation(row.operation),
    ]),
  )
  const levels = new Map<string, ToolAccess>()

  for (const server of servers) {
    if (server.kind !== "wrapper") {
      for (const tool of server.tools) {
        levels.set(accessKey(server.id, tool.name), tool.access)
      }
    }
  }

  const hidden = new Map<string, string>()

  for (const wrapper of wrappers) {
    wrapper.tools = wrapper.tools.map((tool) => {
      const op = opOf.get(accessKey(wrapper.id, tool.name)) ?? {
        calls: [{ serverId: "", tool: "" }],
        replaces: [],
      }
      let access = tool.access

      for (const call of op.calls) {
        const inner =
          levels.get(accessKey(call.serverId, call.tool)) ?? "blocked"

        if (STRICTNESS[inner] > STRICTNESS[access]) {
          access = inner
        }
      }

      if (access !== "blocked") {
        for (const replaced of op.replaces) {
          const key = accessKey(replaced.serverId, replaced.tool)

          if (!hidden.has(key)) {
            hidden.set(key, `${wrapper.slug}/${tool.name}`)
          }
        }
      }

      return { ...tool, access }
    })
  }

  if (hidden.size === 0) {
    return servers
  }

  for (const server of servers) {
    server.tools = server.tools.map((tool) => {
      const by = hidden.get(accessKey(server.id, tool.name))
      return by ? { ...tool, hiddenBy: by } : tool
    })
  }

  return servers
}

/** The tools an assistant with this token may see and call. */
export function visibleTools(server: GatewayServer): GatewayTool[] {
  return server.tools.filter((tool) => tool.access !== "blocked")
}

/**
 * The tools search_tools and list_tools offer: the visible ones, less those
 * a wrapper's tool stands in for.
 */
export function listedTools(server: GatewayServer): GatewayTool[] {
  return visibleTools(server).filter((tool) => !tool.hiddenBy)
}
