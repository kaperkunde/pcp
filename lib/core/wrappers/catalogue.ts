import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { openWrapperSpec } from "../spec-rows"
import { setServerStatus } from "../servers"

import { catalogueTools, readDefinition } from "./definition"
import type { OpenServer } from "../server-meta"

/**
 * A wrapper's tools in the catalogue, built from what the owner approved:
 * nothing is read from anywhere else, so this never fails for a reason but
 * a definition that is not there.
 */
export async function syncWrapperTools(
  ctx: VaultContext,
  server: Pick<OpenServer, "id">,
): Promise<SyncResult> {
  const spec = await db().wrapperSpec.findUnique({
    where: { serverId: server.id },
  })

  if (!spec) {
    const message = "This wrapper has no definition."
    await setServerStatus(ctx, server.id, "error", message)
    return { status: "error", message, toolCount: 0 }
  }

  const toolCount = await storeTools(
    ctx,
    server.id,
    catalogueTools(readDefinition(openWrapperSpec(ctx, spec).definition)),
  )
  await setServerStatus(ctx, server.id, "ok", "", { lastSyncedAt: new Date() })

  return { status: "ok", message: "", toolCount }
}
