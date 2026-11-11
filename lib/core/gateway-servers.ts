import { allowanceHolds, loadToolAllowances } from "./allowances"
import type { ResolvedToken } from "./api-tokens"
import type { DetectedClient } from "./clients/detect"
import type { ToolAccess, ToolTier } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { readServerNote } from "./personal-notes"
import { byServerName, openServer, type OpenServer } from "./server-meta"
import {
  openTools,
  type OpenTool,
  TOOL_ABOUT_SELECT,
  TOOL_OVERRIDE_SELECT,
  TOOL_SCHEMA_SELECT,
  byToolName,
  TOOL_NAME_SELECT,
} from "./tool-rows"
import { accessKey, effectiveAccess, loadToolAccess } from "./tool-access"
import { loadToolTiers } from "./tool-tiers"
import { readWrapperOperation } from "./wrappers/definition"

/**
 * The servers and tools a token reaches, with its level for each: what the
 * gateway (gateway.ts) serves a request from, and what a wrapper's program
 * calls through (lib/core/wrappers/run.ts).
 */

export type GatewayScope = ResolvedToken & {
  publicUrl: string
  /**
   * The app the request comes from and the profile it is answered with
   * (clients/detect.ts), set by /mcp. Without one (the owner's own pages,
   * tests) nothing is said once per session and nothing is repeated.
   */
  client?: DetectedClient
}

/**
 * A tool as the gateway keeps it for a request: enough to search and list,
 * and the token's level for it. The schema and the call plan are read when a
 * tool is described or called, so a request does not carry every tool's
 * schema, which for a large endpoint is megabytes.
 */
export type GatewayTool = Pick<
  OpenTool,
  "id" | "name" | "title" | "description" | "descriptionOverride"
> & {
  access: ToolAccess
  /**
   * Its effective tier (lib/core/tool-tiers.ts): which entry tools run it
   * (execute_<tier> and the ones above).
   */
  tier: ToolTier
  /** The owner's tier for it, when they chose one (else its default). */
  tierOverride: ToolTier | null
  /**
   * A wrapper's tool this token sees stands in for this one ("wrapper/tool"):
   * left out of search and list_tools, still called by its name.
   */
  hiddenBy?: string
}

export type GatewayServer = OpenServer & {
  tools: GatewayTool[]
  /**
   * The owner's own note on the server (lib/core/personal-notes.ts),
   * opened: what assistants read as "Owner's note" beside its description.
   */
  note?: string | null
}

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
 * A wrapper's tool by default never reaches further than the token does: its
 * level is the strictest of its own and of every tool it calls (one the token
 * cannot reach counts as blocked), so a wrapper is blocked wherever one of
 * its calls is, and asks wherever one of them asks. A wrapper the owner
 * approved with its calls ("approved", lib/core/wrappers/definition.ts) has
 * its own level only. The tools a wrapper's tool replaces are hidden from
 * search while that tool is not blocked.
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
          select: { ...TOOL_ABOUT_SELECT, ...TOOL_OVERRIDE_SELECT },
        },
      },
    }),
    loadToolAccess(scope.ctx.vaultId, scope.tokenId),
    loadToolAllowances(scope.tokenId, now),
  ])

  const opened = servers
    .map((row) => ({
      ...openServer(scope.ctx, row),
      tools: openTools(scope.ctx, row.tools).sort(byToolName),
    }))
    .sort(byServerName)
  const tiers = await loadToolTiers(scope.ctx, opened)
  const loaded: GatewayServer[] = opened.map((server) => ({
    ...server,
    note: readServerNote(scope.ctx, server),
    tools: server.tools.map((tool) => {
      const level = effectiveAccess(stored, server.id, tool.name)
      const until = allowances.get(accessKey(server.id, tool.name))

      return {
        ...tool,
        tier: tiers.get(accessKey(server.id, tool.name))?.tier ?? "destructive",
        tierOverride:
          tiers.get(accessKey(server.id, tool.name))?.override ?? null,
        access:
          level === "ask" && allowanceHolds(until, now.getTime())
            ? "allowed"
            : level,
      }
    }),
  }))

  return applyWrappers(scope.ctx, loaded)
}

/** A wrapper's tools at the strictest level, and what they hide. */
async function applyWrappers(
  ctx: VaultContext,
  servers: GatewayServer[],
): Promise<GatewayServer[]> {
  const wrappers = servers.filter((server) => server.kind === "wrapper")

  if (wrappers.length === 0) {
    return servers
  }

  const operations = await db().mcpTool.findMany({
    where: { serverId: { in: wrappers.map((server) => server.id) } },
    select: { ...TOOL_SCHEMA_SELECT, ...TOOL_NAME_SELECT },
  })
  const opOf = new Map(
    openTools(ctx, operations).map((row) => [
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
        callLevels: "token" as const,
      }
      let access = tool.access

      // A wrapper on the owner's approval is held to its own level alone:
      // the calls it lists were approved with it.
      for (const call of op.callLevels === "approved" ? [] : op.calls) {
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
 * The tools search and list_tools offer: the visible ones, less those
 * a wrapper's tool stands in for.
 */
export function listedTools(server: GatewayServer): GatewayTool[] {
  return visibleTools(server).filter((tool) => !tool.hiddenBy)
}
