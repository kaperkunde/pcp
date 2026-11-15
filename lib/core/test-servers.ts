import type { VaultContext } from "./context"
import { db } from "./db"
import { openServer } from "./server-meta"
import {
  openTools,
  type OpenTool,
  sealedToolContent,
  type ToolAbout,
  type ToolSchema,
  byToolName,
} from "./tool-rows"

/**
 * Tests: a server of the vault by its name, opened, with its headers and
 * tools. Names are sealed (#96), so a query cannot find one by name.
 */
export async function serverNamed(ctx: VaultContext, name: string) {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId },
    include: {
      authHeaders: { orderBy: { position: "asc" } },
      tools: true,
    },
    orderBy: { createdAt: "asc" },
  })
  const found = rows
    .map((row) => ({
      ...openServer(ctx, row),
      tools: openTools(ctx, row.tools).sort(byToolName),
    }))
    .find((row) => row.name === name)

  if (!found) {
    throw new Error(`No server named ${name}.`)
  }

  return found
}

/** Tests: the vault's only (or first) server, opened. */
export async function firstServer(ctx: VaultContext) {
  return openServer(
    ctx,
    await db().mcpServer.findFirstOrThrow({
      where: { vaultId: ctx.vaultId },
      orderBy: { createdAt: "asc" },
    }),
  )
}

/** Tests: which tools, by server and by name (names are sealed, #96). */
export type ToolFilter = {
  serverId?: string
  name?: string | { in: readonly string[] }
}

/** Tests: the vault's tools the filter names, opened, by name. */
export async function toolsWhere(
  ctx: VaultContext,
  filter: ToolFilter = {},
): Promise<OpenTool[]> {
  const rows = await db().mcpTool.findMany({
    where: {
      server: { vaultId: ctx.vaultId },
      ...(filter.serverId ? { serverId: filter.serverId } : {}),
    },
  })
  const names =
    filter.name === undefined
      ? null
      : typeof filter.name === "string"
        ? [filter.name]
        : filter.name.in

  return openTools(ctx, rows)
    .filter((tool) => !names || names.includes(tool.name))
    .sort(byToolName)
}

/** Tests: the one tool of that name (on that server), opened. */
export async function toolNamed(
  ctx: VaultContext,
  name: string,
  serverId?: string,
): Promise<OpenTool> {
  const [tool] = await toolsWhere(ctx, { name, serverId })

  if (!tool) {
    throw new Error(`No tool named ${name}.`)
  }

  return tool
}

/**
 * Tests: changes the title, description or schemas of the tools the
 * filter names, sealed as PCP writes them.
 */
export async function editTools(
  ctx: VaultContext,
  filter: ToolFilter,
  patch: Partial<ToolAbout & ToolSchema>,
): Promise<void> {
  for (const tool of await toolsWhere(ctx, filter)) {
    await db().mcpTool.update({
      where: { id: tool.id },
      data: sealedToolContent(ctx, tool.id, tool.serverId, {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        operation: tool.operation,
        output: tool.output,
        ...patch,
      }),
    })
  }
}
