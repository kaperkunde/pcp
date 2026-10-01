import { randomUUID } from "node:crypto"

import { db } from "./db"

/**
 * Writing a server's tool list into the catalogue (mcp_tool), whichever way
 * it was read: an MCP server's tools/list or the operations of an OpenAPI
 * schema. Tools that disappeared are removed; the owner's description
 * overrides are never touched, so they survive a refresh.
 */

export type SyncResult = {
  status: "ok" | "auth_required" | "client_required" | "error"
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
  /** openapi: what a successful call answers, in outline. */
  output?: string | null
}

const DELETE_CHUNK = 500

/**
 * Whether reading a server's tools again can find anything new: an MCP
 * server's tools change whenever its makers ship, and so can a schema
 * fetched from an address. An uploaded schema changes only when the owner
 * uploads another.
 */
export function canRereadTools(server: {
  kind: string
  specSource: string | null
}): boolean {
  return server.kind !== "openapi" || server.specSource === "url"
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
          output: tool.output ?? null,
        }

        await tx.mcpTool.upsert({
          where: { serverId_name: { serverId, name: tool.name } },
          create: { id: randomUUID(), serverId, name: tool.name, ...fields },
          update: fields,
        })
      }

      // The names that are gone, in chunks: SQLite allows 999 variables in
      // a query, and "NOT IN (every current name)" is one per tool.
      const gone = (
        await tx.mcpTool.findMany({
          where: { serverId },
          select: { name: true },
        })
      )
        .map((tool) => tool.name)
        .filter((name) => !names.has(name))

      for (let at = 0; at < gone.length; at += DELETE_CHUNK) {
        await tx.mcpTool.deleteMany({
          where: { serverId, name: { in: gone.slice(at, at + DELETE_CHUNK) } },
        })
      }
    },
    { timeout: 60_000 },
  )

  return names.size
}
