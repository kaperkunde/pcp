import type { VaultContext } from "../context"
import { db } from "../db"
import { visibleTools, type GatewayServer } from "../gateway-servers"
import { readServiceDefinition } from "../services/definition"
import { itemOfImage, type CapabilityId } from "./list"
import { MAX_SCHEMAS_READ } from "./limits"
import {
  providersOf,
  type CandidateTool,
  type OperationId,
  type Provider,
} from "./providers"

/**
 * The token's tools as provider detection reads them (providers.ts): the
 * ones it can call or ask for, with their input schemas and their server's
 * kind, and for each server the common item it was launched from and the
 * service with a files folder that registered it. The browser's own tools
 * never count; a blocked tool is not there.
 */

/** Words that make a tool worth reading the schema of. */
const WORTH_READING =
  /ocr|optical|tesseract|convert|export|markdown|text|form|flatten|merge|combine|sign|pdf|document|image|scan|read|extract|file|render|page/i

export async function candidateTools(
  servers: GatewayServer[],
): Promise<CandidateTool[]> {
  const listed = servers
    .filter((server) => server.kind !== "browser")
    .flatMap((server) =>
      visibleTools(server)
        .filter((tool) =>
          WORTH_READING.test(
            `${tool.name} ${tool.title ?? ""} ${tool.descriptionOverride ?? tool.description ?? ""}`,
          ),
        )
        .map((tool) => ({ server, tool })),
    )
    .slice(0, MAX_SCHEMAS_READ)

  if (listed.length === 0) {
    return []
  }

  const schemas = new Map(
    (
      await db().mcpTool.findMany({
        where: { id: { in: listed.map(({ tool }) => tool.id) } },
        select: { id: true, inputSchema: true },
      })
    ).map((row) => [row.id, row.inputSchema]),
  )

  return listed.map(({ server, tool }) => {
    let schema: unknown = null

    try {
      schema = JSON.parse(schemas.get(tool.id) ?? "null")
    } catch {
      schema = null
    }

    return {
      serverId: server.id,
      server: server.slug,
      tool: tool.name,
      title: tool.title,
      description: tool.descriptionOverride ?? tool.description ?? "",
      access: tool.access === "allowed" ? "allowed" : "ask",
      tier: tool.tier,
      schema,
      kind: server.kind,
    }
  })
}

/**
 * What the services that registered these servers say of them: the common
 * item each was launched from, by its image or source tag (the second
 * signal), and the service whose definition names a files folder, by the
 * server's id (its own put_file and get_file are the file step there).
 */
export async function serverOrigins(
  ctx: VaultContext,
  serverIds: string[],
): Promise<{ items: Map<string, string>; services: Map<string, string> }> {
  const items = new Map<string, string>()
  const services = new Map<string, string>()

  if (serverIds.length === 0) {
    return { items, services }
  }

  const specs = await db().serviceSpec.findMany({
    where: {
      registeredId: { in: serverIds },
      server: { vaultId: ctx.vaultId },
    },
    select: { serverId: true, registeredId: true, definition: true },
  })

  for (const spec of specs) {
    if (!spec.registeredId) {
      continue
    }

    try {
      const definition = readServiceDefinition(spec.definition)
      const item = itemOfImage(
        `${definition.image ?? ""} ${definition.source ?? ""}`,
      )

      if (item) {
        items.set(spec.registeredId, item.name)
      }

      if (definition.files) {
        services.set(spec.registeredId, spec.serverId)
      }
    } catch {
      // A stored definition that no longer reads says nothing.
    }
  }

  return { items, services }
}

/** A capability's providers among the token's servers, by operation. */
export async function capabilityProviders(
  ctx: VaultContext,
  servers: GatewayServer[],
  id: CapabilityId,
): Promise<Partial<Record<OperationId, Provider[]>>> {
  const tools = await candidateTools(servers)

  if (tools.length === 0) {
    return {}
  }

  const { items, services } = await serverOrigins(ctx, [
    ...new Set(tools.map((tool) => tool.serverId)),
  ])

  return providersOf(id, tools, items, services)
}
