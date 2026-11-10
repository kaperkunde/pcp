import type { Client } from "@modelcontextprotocol/client"

import { makeCallHandle } from "./call-handles"
import { db } from "./db"
import type { GatewayScope } from "./gateway"

/**
 * For tests that call tools through the gateway: execute_<tier> takes the
 * call_handle search gives for a ref, so a test looks the tool up first,
 * as an assistant does.
 */

function textOf(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .map((part) => part.text ?? "")
    .join("")
}

/** The tools a client lists (#113); everything else of PCP's is behind them. */
const ENTRIES = new Set([
  "search",
  ...["read", "write", "destructive"].flatMap((tier) => [
    `execute_${tier}`,
    `run_${tier}`,
  ]),
])

/**
 * A call of one of PCP's tools by the name it had before #113, as an
 * assistant makes it now: one of PCP's own tools through
 * execute_destructive by name (which runs every tier), describe as search's
 * ref, an entry as it is.
 */
export function entryCall(
  name: string,
  args: Record<string, unknown> = {},
): { name: string; arguments: Record<string, unknown> } {
  if (ENTRIES.has(name)) {
    return { name, arguments: args }
  }

  if (name === "describe") {
    const { server, tool, ref } = args

    return {
      name: "search",
      arguments: {
        ref:
          typeof server === "string" && typeof tool === "string"
            ? `${server}/${tool}`
            : ref,
      },
    }
  }

  return {
    name: "execute_destructive",
    arguments: { tool: name, arguments: args },
  }
}

/** The call_handle search answers with for server/tool's ref. */
export async function describedHandle(
  client: Client,
  server: string,
  tool: string,
): Promise<string> {
  const result = await client.callTool({
    name: "search",
    arguments: { ref: `${server}/${tool}` },
  })
  const text = textOf(result)

  if (result.isError) {
    throw new Error(`search ${server}/${tool}: ${text}`)
  }

  return (JSON.parse(text) as { call_handle: string }).call_handle
}

/**
 * execute's arguments for a call written with a server and a tool name:
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
 * The handle search would give, made from the catalogue: for a tool
 * search no longer shows (one the owner blocked after it was
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

/** A tool as listTools gives one: an entry, or one of PCP's own behind them. */
export type ListedTool = {
  name: string
  title?: string
  description?: string
  inputSchema: {
    type: "object"
    properties?: Record<string, unknown>
  } & Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

/**
 * Every tool of PCP's a token has, as listTools gave them before #113: the
 * entries a client lists, then PCP's own tools behind them, as search's ref
 * describes each (kind pcp).
 */
export async function listEveryTool(
  client: Client,
): Promise<{ tools: ListedTool[] }> {
  const listed = (await client.listTools()).tools as ListedTool[]
  const found = textOf(
    await client.callTool({
      name: "search",
      arguments: { query: "", kind: "pcp", limit: 50 },
    }),
  )
  const names = found
    .split("\n")
    .filter((line) => line.startsWith("pcp "))
    .map((line) => line.split(" ")[1]!)
  const own = await Promise.all(
    names.map(async (name) => {
      const tool = JSON.parse(
        textOf(
          await client.callTool({ name: "search", arguments: { ref: name } }),
        ),
      ) as {
        tool: string
        title?: string
        description?: string
        inputSchema: ListedTool["inputSchema"]
        outputSchema?: Record<string, unknown>
        annotations?: ListedTool["annotations"]
      }

      return {
        name: tool.tool,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
      }
    }),
  )

  return { tools: [...listed, ...own] }
}
