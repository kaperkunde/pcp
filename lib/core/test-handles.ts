import type { Client } from "@modelcontextprotocol/client"

import { makeCallHandle } from "./call-handles"
import { db } from "./db"
import type { GatewayScope } from "./gateway"

/**
 * For tests that call tools through the gateway: call_tool takes the
 * call_handle describe_tool gives, so a test describes the tool first, as
 * an assistant does.
 */

function textOf(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .map((part) => part.text ?? "")
    .join("")
}

/** The call_handle describe_tool answers with for server/tool. */
export async function describedHandle(
  client: Client,
  server: string,
  tool: string,
): Promise<string> {
  const result = await client.callTool({
    name: "describe_tool",
    arguments: { server, tool },
  })
  const text = textOf(result)

  if (result.isError) {
    throw new Error(`describe_tool ${server}/${tool}: ${text}`)
  }

  return (JSON.parse(text) as { call_handle: string }).call_handle
}

/**
 * call_tool's arguments for a call written with a server and a tool name:
 * the tool described first, its handle in their place. Anything without
 * both is passed on as it is.
 */
export async function withCallHandle(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { server, tool, ...rest } = args

  if (typeof server !== "string" || typeof tool !== "string") {
    return args
  }

  return { call_handle: await describedHandle(client, server, tool), ...rest }
}

/**
 * The handle describe_tool would give, made from the catalogue: for a tool
 * describe_tool no longer shows (one the owner blocked after it was
 * described).
 */
export async function catalogueHandle(
  scope: Pick<GatewayScope, "ctx" | "tokenId">,
  slug: string,
  tool: string,
): Promise<string> {
  const row = await db().mcpTool.findFirstOrThrow({
    where: { name: tool, server: { slug, vaultId: scope.ctx.vaultId } },
  })

  return makeCallHandle(scope.ctx.dek, {
    tokenId: scope.tokenId,
    serverId: row.serverId,
    toolId: row.id,
    tool: row.name,
    inputSchema: row.inputSchema,
  })
}
