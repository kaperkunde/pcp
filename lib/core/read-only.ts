import { db } from "./db"
import { readWrapperOperation } from "./wrappers/definition"

/**
 * Whether a tool's server marks it read-only, as its stored annotations say:
 * an API's GET, PCP's own reads of a mail account or the browser, or what an
 * MCP server declares. Anything unreadable counts as not.
 */
export async function markedReadOnly(
  serverId: string,
  name: string,
): Promise<boolean> {
  const row = await db().mcpTool.findUnique({
    where: { serverId_name: { serverId, name } },
    select: {
      annotations: true,
      operation: true,
      server: { select: { kind: true } },
    },
  })

  if (!row?.annotations) {
    return false
  }

  let marked = false

  try {
    const annotations: unknown = JSON.parse(row.annotations)
    marked =
      typeof annotations === "object" &&
      annotations !== null &&
      (annotations as { readOnlyHint?: unknown }).readOnlyHint === true
  } catch {
    return false
  }

  // A wrapper's tool says so itself; it only reads when every tool its
  // program calls does (never a wrapper's, so this goes one level down).
  if (marked && row.server.kind === "wrapper") {
    const { calls } = readWrapperOperation(row.operation)

    for (const call of calls) {
      if (!(await markedReadOnly(call.serverId, call.tool))) {
        return false
      }
    }
  }

  return marked
}
