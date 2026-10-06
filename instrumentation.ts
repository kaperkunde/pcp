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

    // What PCP keeps only for a while (ended sign-ins, kept results, old
    // permission requests, old days of the request log): removed once now,
    // then on the owner's schedule (lib/core/cleanup/runtime.ts).
    const { startCleanup } = await import("@/lib/core/cleanup/runtime")
    await startCleanup()

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
