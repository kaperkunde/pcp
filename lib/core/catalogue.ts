import { randomUUID } from "node:crypto"

import type { VaultContext } from "./context"
import { db } from "./db"
import { inheritedToolDescriptions } from "./definition-rows"
import {
  TOOL_ABOUT_SELECT,
  toolName,
  sealedToolContent,
  sealedToolOverride,
  splitAnnotations,
} from "./tool-rows"

/**
 * Writing a server's tool list into the catalogue (mcp_tool), whichever way
 * it was read: an MCP server's tools/list or the operations of an OpenAPI
 * schema. Tools that disappeared are removed; the owner's description
 * overrides are never touched, so they survive a refresh. A tool new to a
 * server that shares its definition with others starts with the
 * description in the owner's words that they have for it.
 */

export type SyncResult = {
  status: "ok" | "auth_required" | "client_required" | "refused" | "error"
  message: string
  toolCount: number
}

export type CatalogueTool = {
  name: string
  title?: string | null
  description?: string | null
  inputSchema: unknown
  annotations?: unknown
  /** openapi: the call plan, as JSON. Null for MCP and mail tools. */
  operation?: string | null
  /** openapi: what a successful call answers, in outline. */
  output?: string | null
  /** The JSON Schema of a successful call's structuredContent, if declared. */
  outputSchema?: unknown
  /** The icons an MCP server gave the tool. */
  icons?: unknown
}

const DELETE_CHUNK = 500

/**
 * Whether reading a server's tools again can find anything new: an MCP
 * server's tools change whenever its makers ship, and so can a schema
 * fetched from an address. An uploaded schema changes only when the owner
 * uploads another. A mail account is read again too: whether it may send
 * can change, and reading it checks that it still signs in. A wrapper's
 * tools change only when the owner changes it.
 */
export function canRereadTools(server: {
  kind: string
  specSource: string | null
}): boolean {
  return (
    server.kind !== "wrapper" &&
    (server.kind !== "openapi" || server.specSource === "url")
  )
}

export async function storeTools(
  ctx: VaultContext,
  serverId: string,
  tools: CatalogueTool[],
): Promise<number> {
  const names = new Set<string>()
  const inherited = await inheritedToolDescriptions(ctx, serverId)

  // One transaction: a schema with hundreds of operations is one write,
  // not hundreds, and a failure leaves the previous list in place.
  await db().$transaction(
    async (tx) => {
      // Each value is sealed under its row's id: an existing tool keeps its
      // own.
      const known = new Map(
        (
          await tx.mcpTool.findMany({
            where: { serverId },
            select: TOOL_ABOUT_SELECT,
          })
        ).map((tool) => [toolName(ctx, tool), tool.id]),
      )

      for (const tool of tools) {
        names.add(tool.name)
        const id = known.get(tool.name) ?? randomUUID()
        const annotations = splitAnnotations(tool.annotations)
        const fields = {
          ...sealedToolContent(ctx, id, serverId, {
            name: tool.name,
            title: tool.title ?? null,
            description: tool.description ?? "",
            annotationsTitle: annotations.annotationsTitle,
            inputSchema: JSON.stringify(tool.inputSchema ?? { type: "object" }),
            operation: tool.operation ?? null,
            output: tool.output ?? null,
            outputSchema:
              tool.outputSchema === undefined || tool.outputSchema === null
                ? null
                : JSON.stringify(tool.outputSchema),
          }),
          annotations: annotations.annotations,
          icons:
            tool.icons === undefined || tool.icons === null
              ? null
              : JSON.stringify(tool.icons),
        }

        if (known.has(tool.name)) {
          await tx.mcpTool.update({ where: { id }, data: fields })
        } else {
          await tx.mcpTool.create({
            data: {
              id,
              serverId,
              ...sealedToolOverride(ctx, id, inherited.get(tool.name) ?? null),
              ...fields,
            },
          })
        }
      }

      // The tools that are gone, by id, in chunks: SQLite allows 999
      // variables in a query. Their names are sealed, so known (read
      // above, in this transaction) says which they are.
      const gone = [...known]
        .filter(([name]) => !names.has(name))
        .map(([, id]) => id)

      for (let at = 0; at < gone.length; at += DELETE_CHUNK) {
        await tx.mcpTool.deleteMany({
          where: { serverId, id: { in: gone.slice(at, at + DELETE_CHUNK) } },
        })
      }
    },
    { timeout: 60_000 },
  )

  return names.size
}
