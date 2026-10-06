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
    const { pruneToolResults } = await import("@/lib/core/tool-results")
    await Promise.all([
      pruneExpiredSessions(),
      pruneOAuthStates(),
      prunePermissionRequests(),
      pruneToolResults(),
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

    // The browser's tools are fixed in the code, so a new version brings
    // them up to date; and whether Chromium is here can change with it.
    const { syncAllBrowserTools } = await import("@/lib/core/browser/server")
    void syncAllBrowserTools().catch((error) =>
      console.error("[browser] could not update the browser's tools", error),
    )

    // Dynamic DNS and HTTPS, if the owner turned them on: off by default,
    // so nothing listens or runs here for anyone with a proxy of their own.
    const { startNetwork } = await import("@/lib/core/network/runtime")
    await startNetwork()

    // The daily check for a newer release, unless the owner turned it off:
    // then there is no timer and no request (lib/core/updates/runtime.ts).
    const { startUpdates } = await import("@/lib/core/updates/runtime")
    await startUpdates()

    // run_code's sandbox container, when the compose file for it set
    // PCP_SANDBOX_SOCKET: PCP listens there for its runner. Without it
    // nothing listens (lib/core/code/sandbox.ts).
    const { startSandbox } = await import("@/lib/core/code/sandbox")
    await startSandbox().catch((error) =>
      console.error("[sandbox] could not listen for the runner", error),
    )
  }
}
