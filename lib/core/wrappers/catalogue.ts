import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import { db } from "../db"
import { setServerStatus } from "../servers"

import { catalogueTools, readDefinition } from "./definition"

/**
 * A wrapper's tools in the catalogue, built from what the owner approved:
 * nothing is read from anywhere else, so this never fails for a reason but
 * a definition that is not there.
 */
export async function syncWrapperTools(
  server: Pick<McpServer, "id">,
): Promise<SyncResult> {
  const spec = await db().wrapperSpec.findUnique({
    where: { serverId: server.id },
  })

  if (!spec) {
    const message = "This wrapper has no definition."
    await setServerStatus(server.id, "error", message)
    return { status: "error", message, toolCount: 0 }
  }

  const toolCount = await storeTools(
    server.id,
    catalogueTools(readDefinition(spec.definition)),
  )
  await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })

  return { status: "ok", message: "", toolCount }
}
