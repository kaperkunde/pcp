import { randomUUID } from "node:crypto"

import { db } from "./db"

/**
 * Writing a server's tool list into the catalogue (mcp_tool), whichever way
 * it was read: an MCP server's tools/list or the operations of an OpenAPI
 * schema. Tools that disappeared are removed; the owner's description
 * overrides are never touched, so they survive a refresh.
 */

export type SyncResult = {
  status: "ok" | "auth_required" | "error"
  message: string
  toolCount: number
}

export type CatalogueTool = {
  name: string
  title?: string | null
  description?: string | null
  inputSchema: unknown
  annotations?: unknown
  /** openapi: the call plan, as JSON. */
  operation?: string | null
}

export async function storeTools(
  serverId: string,
  tools: CatalogueTool[],
): Promise<number> {
  const names = new Set<string>()

  // One transaction: a schema with hundreds of operations is one write,
  // not hundreds, and a failure leaves the previous list in place.
  await db().$transaction(
    async (tx) => {
      for (const tool of tools) {
        names.add(tool.name)
        const fields = {
          title: tool.title ?? null,
          description: tool.description ?? "",
          inputSchema: JSON.stringify(tool.inputSchema ?? { type: "object" }),
          annotations: tool.annotations
            ? JSON.stringify(tool.annotations)
            : null,
          operation: tool.operation ?? null,
        }

        await tx.mcpTool.upsert({
          where: { serverId_name: { serverId, name: tool.name } },
          create: { id: randomUUID(), serverId, name: tool.name, ...fields },
          update: fields,
        })
      }

      await tx.mcpTool.deleteMany({
        where: { serverId, name: { notIn: [...names] } },
      })
    },
    { timeout: 60_000 },
  )

  return names.size
}
