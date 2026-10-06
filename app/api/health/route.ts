import { db } from "@/lib/core/db"
import { pendingInstallRequest } from "@/lib/core/updates/state"
import { PCP_VERSION } from "@/lib/core/version"
import { isDesktopApp } from "@/lib/server/desktop"

export const dynamic = "force-dynamic"

/**
 * For the container healthcheck: can the app reach its database? In the
 * desktop app it also says which version runs and whether the owner asked
 * the app to install an update ("Install and restart" on Settings), which the
 * app reads here because the page cannot reach it (desktop/updates.mjs).
 * Nothing of the vault is in it.
 */
export async function GET() {
  try {
    await db().vault.count()
  } catch (error) {
    console.error("[health] database check failed", error)
    return Response.json({ status: "error" }, { status: 503 })
  }

  if (!isDesktopApp()) {
    return Response.json({ status: "ok" })
  }

  return Response.json({
    status: "ok",
    version: PCP_VERSION,
    // Never a reason to report the server unwell.
    installRequest: await pendingInstallRequest().catch(() => null),
  })
}
