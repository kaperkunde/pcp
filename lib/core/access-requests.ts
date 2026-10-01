import { requireLiveToken } from "./api-tokens"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  type ToolAccess,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"
import {
  accessKey,
  listTokenToolAccess,
  parseToolAccess,
  type TokenServerAccess,
} from "./tool-access"

/**
 * An assistant's proposal for its own token's tool levels
 * (propose_tool_access). It can name many tools at once, by name or by
 * pattern, across servers, which is what makes a large catalogue manageable;
 * but it only ever proposes. The proposal is a permission request of kind
 * "access" (lib/core/permissions.ts) whose page fills the levels in, marks
 * what would change, and writes nothing until the owner saves there. No
 * prompt in the client and no panel button can save it, so an assistant
 * cannot raise its own access by answering for the owner.
 */

/** One change as an assistant asks for it. */
export type AccessChange = {
  /** The server's short name. */
  server: string
  /** Tool names or patterns with `*`; every tool on the server when absent. */
  tools?: string[]
  access: ToolAccess
}

/** One tool's level, resolved against the catalogue. */
export type AccessLevel = {
  serverId: string
  tool: string
  access: ToolAccess
}

export type AccessAsk = { kind: "access"; input: { levels: AccessLevel[] } }

/** What the resolver reads of a server: the gateway's view of it. */
export type AccessServer = {
  id: string
  slug: string
  tools: Array<{ name: string; access: ToolAccess }>
}

export const MAX_ACCESS_CHANGES = 100
export const MAX_ACCESS_PATTERNS = 500
/** The most levels one save may write. */
export const MAX_ACCESS_LEVELS = 20_000

function matcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes("*")) {
    return (name) => name === pattern
  }

  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  const regex = new RegExp(`^${source}$`)

  return (name) => regex.test(name)
}

/**
 * Turns an assistant's changes into one level per tool, leaving out the
 * tools that already have the level asked for. Later changes win, so a whole
 * server can be set first and its exceptions after. Blocked tools are hidden
 * from the assistant, so it cannot name them and no pattern reaches them:
 * unblocking one is the owner's to do on the page.
 */
export function resolveAccessChanges(
  servers: AccessServer[],
  changes: AccessChange[],
): AccessLevel[] {
  if (changes.length === 0) {
    throw invalid("Name at least one change.")
  }

  if (changes.length > MAX_ACCESS_CHANGES) {
    throw invalid(
      `At most ${MAX_ACCESS_CHANGES} changes at once; use patterns such as "list_*" to cover more tools with one.`,
    )
  }

  const bySlug = new Map(servers.map((server) => [server.slug, server]))
  const wanted = new Map<string, AccessLevel>()

  for (const change of changes) {
    const access = parseToolAccess(change.access)
    const server = bySlug.get(change.server)

    if (!server) {
      throw invalid(
        `No server called ${change.server}. Servers: ${[...bySlug.keys()].join(", ") || "(none)"}.`,
      )
    }

    const visible = server.tools.filter((tool) => tool.access !== "blocked")
    const patterns = change.tools

    if (patterns && patterns.length > MAX_ACCESS_PATTERNS) {
      throw invalid(
        `At most ${MAX_ACCESS_PATTERNS} tool names in one change; use patterns such as "list_*".`,
      )
    }

    let chosen = visible

    if (patterns && patterns.length > 0) {
      const tests = patterns.map((pattern) => ({
        pattern,
        test: matcher(pattern),
      }))
      const unmatched = tests.filter(
        ({ test }) => !visible.some((tool) => test(tool.name)),
      )

      if (unmatched.length > 0) {
        throw invalid(
          `${server.slug} has no tool matching ${unmatched
            .slice(0, 5)
            .map(({ pattern }) => `"${pattern}"`)
            .join(
              ", ",
            )}${unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ""}. Use search_tools to find the right names.`,
        )
      }

      chosen = visible.filter((tool) =>
        tests.some(({ test }) => test(tool.name)),
      )
    }

    for (const tool of chosen) {
      wanted.set(accessKey(server.id, tool.name), {
        serverId: server.id,
        tool: tool.name,
        access,
      })
    }
  }

  const current = new Map(
    servers.flatMap((server) =>
      server.tools.map(
        (tool) => [accessKey(server.id, tool.name), tool.access] as const,
      ),
    ),
  )

  return [...wanted.entries()]
    .filter(([key, level]) => current.get(key) !== level.access)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, level]) => level)
}

/** "3 to Allowed, 1 to Blocked", in the order of the levels. */
export function countByLevel(levels: Array<{ access: ToolAccess }>): string {
  return TOOL_ACCESS_LEVELS.flatMap((access) => {
    const count = levels.filter((level) => level.access === access).length
    return count > 0 ? [`${count} to ${TOOL_ACCESS_LABELS[access]}`] : []
  }).join(", ")
}

function tools(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`
}

const MAX_SERVER_LINES = 20

/** What the owner and the assistant read about a proposal. */
export function describeAccessAsk(
  levels: AccessLevel[],
  servers: Array<{ id: string; name: string; slug: string }>,
): { title: string; lines: string[]; warning: string | null } {
  const byId = new Map(servers.map((server) => [server.id, server]))
  const perServer = new Map<string, AccessLevel[]>()

  for (const level of levels) {
    perServer.set(level.serverId, [
      ...(perServer.get(level.serverId) ?? []),
      level,
    ])
  }

  const serverLines = [...perServer.entries()].map(([id, group]) => {
    const server = byId.get(id)
    const label = server
      ? `${server.name} (${server.slug})`
      : "A server that was removed"
    return `${label}: ${countByLevel(group)}`
  })
  const allowed = levels.filter((level) => level.access === "allowed").length

  return {
    title: "Change which tools an assistant may run?",
    lines: [
      `${tools(levels.length)} would change: ${countByLevel(levels)}`,
      ...serverLines.slice(0, MAX_SERVER_LINES),
      ...(serverLines.length > MAX_SERVER_LINES
        ? [`And ${serverLines.length - MAX_SERVER_LINES} more servers`]
        : []),
      "Nothing changes until you review the levels in PCP and save them.",
    ],
    warning:
      allowed > 0
        ? `Allowed tools run without asking you. This would allow ${tools(allowed)}; check them before you save.`
        : null,
  }
}

/**
 * The owner's levels as the review page sends them, checked against the
 * tools the token reaches now. Throws on anything else.
 */
export async function checkAccessLevels(
  ctx: VaultContext,
  tokenId: string,
  levels: unknown,
): Promise<AccessLevel[]> {
  if (!Array.isArray(levels)) {
    throw invalid("Send the levels as a list.")
  }

  if (levels.length > MAX_ACCESS_LEVELS) {
    throw invalid("That is more levels than PCP saves at once.")
  }

  const reachable = new Set(
    (await listTokenToolAccess(ctx, tokenId)).flatMap((server) =>
      server.tools.map((tool) => accessKey(server.id, tool.name)),
    ),
  )
  const checked = new Map<string, AccessLevel>()

  for (const entry of levels as unknown[]) {
    const { serverId, tool, access } = (entry ?? {}) as Record<string, unknown>

    if (typeof serverId !== "string" || typeof tool !== "string") {
      throw invalid("Each level names a server and a tool.")
    }

    const key = accessKey(serverId, tool)

    if (!reachable.has(key)) {
      throw invalid(
        `This token no longer reaches ${tool}. Reload the page to see its tools as they are now.`,
      )
    }

    checked.set(key, {
      serverId,
      tool,
      access: parseToolAccess(String(access)),
    })
  }

  return [...checked.values()]
}

/** Writes levels for one token in one transaction. */
export async function writeAccessLevels(
  ctx: VaultContext,
  tokenId: string,
  levels: AccessLevel[],
): Promise<void> {
  await requireLiveToken(ctx, tokenId)

  const byServer = new Map<string, string[]>()

  for (const level of levels) {
    byServer.set(level.serverId, [
      ...(byServer.get(level.serverId) ?? []),
      level.tool,
    ])
  }

  const stored = levels.filter((level) => level.access !== "ask")

  await db().$transaction([
    ...[...byServer.entries()].map(([serverId, names]) =>
      db().apiTokenToolAccess.deleteMany({
        where: { tokenId, serverId, toolName: { in: names } },
      }),
    ),
    ...(stored.length > 0
      ? [
          db().apiTokenToolAccess.createMany({
            data: stored.map((level) => ({
              tokenId,
              serverId: level.serverId,
              toolName: level.tool,
              access: level.access,
            })),
          }),
        ]
      : []),
  ])
}

/** What the assistant is told once the owner saved. */
export function describeSavedAccess(
  proposed: AccessLevel[],
  saved: AccessLevel[],
): string {
  const savedByKey = new Map(
    saved.map((level) => [accessKey(level.serverId, level.tool), level.access]),
  )
  const proposedKeys = new Set(
    proposed.map((level) => accessKey(level.serverId, level.tool)),
  )
  const notTaken = proposed.filter(
    (level) =>
      savedByKey.get(accessKey(level.serverId, level.tool)) !== level.access,
  ).length
  const others = saved.filter(
    (level) => !proposedKeys.has(accessKey(level.serverId, level.tool)),
  ).length

  return [
    saved.length === 0
      ? "The owner saved without changing any tool's level."
      : `The owner saved new levels for ${tools(saved.length)}: ${countByLevel(saved)}.`,
    ...(notTaken > 0
      ? [
          `They did not take ${notTaken} of the ${proposed.length} levels you proposed.`,
        ]
      : saved.length > 0
        ? ["Every level you proposed was saved."]
        : []),
    ...(others > 0
      ? [`They also changed ${tools(others)} you did not name.`]
      : []),
  ].join(" ")
}

/**
 * What the review page shows: every server the token reaches with its tools
 * as they are, and the proposed levels still about tools it reaches.
 */
export async function accessReview(
  ctx: VaultContext,
  tokenId: string,
  proposed: AccessLevel[],
): Promise<{
  servers: TokenServerAccess[]
  proposed: AccessLevel[]
  /** Proposed levels for tools the token no longer reaches. */
  gone: number
}> {
  const servers = await listTokenToolAccess(ctx, tokenId)
  const reachable = new Set(
    servers.flatMap((server) =>
      server.tools.map((tool) => accessKey(server.id, tool.name)),
    ),
  )
  const kept = proposed.filter((level) =>
    reachable.has(accessKey(level.serverId, level.tool)),
  )

  return { servers, proposed: kept, gone: proposed.length - kept.length }
}
