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

    // Dynamic DNS and HTTPS, if the owner turned them on: off by default,
    // so nothing listens or runs here for anyone with a proxy of their own.
    const { startNetwork } = await import("@/lib/core/network/runtime")
    await startNetwork()
  }
}
