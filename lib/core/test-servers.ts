import type { Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { db } from "./db"
import { openServer } from "./server-meta"
import {
  openTool,
  openTools,
  sealedToolContent,
  type ToolAbout,
  type ToolSchema,
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
      tools: { orderBy: { name: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  })
  const found = rows
    .map((row) => ({
      ...openServer(ctx, row),
      tools: openTools(ctx, row.tools),
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

/**
 * Tests: changes the title, description or schemas of the tools `where`
 * finds, sealed as PCP writes them.
 */
export async function editTools(
  ctx: VaultContext,
  where: Prisma.McpToolWhereInput,
  patch: Partial<ToolAbout & ToolSchema>,
): Promise<void> {
  const rows = await db().mcpTool.findMany({ where })

  for (const row of rows) {
    const tool = openTool(ctx, row)
    await db().mcpTool.update({
      where: { id: row.id },
      data: sealedToolContent(ctx, row.id, {
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
