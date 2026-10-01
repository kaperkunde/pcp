export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The schema is brought up to date before the first request: a single
    // container with a SQLite file has nowhere else to do it. See
    // lib/core/migrate.ts for why this is not `prisma migrate deploy`.
    const { applyMigrations } = await import("@/lib/core/migrate")
    const result = applyMigrations()

    if (result.applied.length > 0) {
      console.log(
        `[db] applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`,
      )
    }

    const { pruneExpiredSessions } = await import("@/lib/core/sessions")
    const { pruneOAuthStates } = await import("@/lib/core/oauth")
    const { prunePermissionRequests } = await import("@/lib/core/permissions")
    await Promise.all([
      pruneExpiredSessions(),
      pruneOAuthStates(),
      prunePermissionRequests(),
    ]).catch((error) => console.error("[db] cleanup failed", error))

    // Not waited for: until it is done, endpoints answer with the tools
    // they had.
    const { rebuildOutdatedEndpoints } = await import("@/lib/core/endpoints")
    void rebuildOutdatedEndpoints()
      .then(({ rebuilt, failed }) => {
        if (rebuilt > 0) {
          console.log(`[endpoints] rebuilt the tools of ${rebuilt} endpoint(s)`)
        }
        for (const { serverId, message } of failed) {
          console.error("[endpoints] could not rebuild tools", {
            server: serverId,
            message,
          })
        }
      })
      .catch((error) => console.error("[endpoints] rebuild failed", error))
  }
}
