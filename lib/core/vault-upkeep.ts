import type { VaultContext } from "./context"

/**
 * What a vault needs done once a process holds its key: the work that once
 * ran at boot, before the vault's tools and schemas were sealed under its
 * key (#96). The first request this process sees of a vault runs it, after
 * the answer (`after()` from /mcp and the owner's pages, beside
 * ensureSealed); never a timer, and never without a request's key.
 *
 *  - Endpoints another PCP version built are built again from the copy of
 *    their schema PCP holds (endpoints.ts rebuildOutdatedEndpoints).
 *  - The browser's tools, fixed in the code, are written again, and its
 *    status says whether Chromium is here (browser/server.ts). Chromium
 *    installed since asks for that again on the vault's next request.
 */

const STATE = Symbol.for("pcp.vault-upkeep")

type UpkeepState = {
  /** Vaults this process has caught up, by the browser's generation then. */
  done: Map<string, number>
  /** Counts Chromium installs this process made: each asks for a check. */
  browserGeneration: number
  running: Map<string, Promise<void>>
}

function upkeepState(): UpkeepState {
  // On globalThis: the routes are bundled apart.
  const holder = globalThis as unknown as { [STATE]?: UpkeepState }
  holder[STATE] ??= {
    done: new Map(),
    browserGeneration: 0,
    running: new Map(),
  }
  return holder[STATE]
}

/** Chromium changed on this machine: each vault's browser is checked again. */
export function noteBrowserChanged(): void {
  upkeepState().browserGeneration++
}

/** The vault's rows were replaced (a restore): it is caught up again. */
export function forgetVaultUpkeep(vaultId: string): void {
  upkeepState().done.delete(vaultId)
}

/** Tests: forget every vault. */
export function forgetVaultUpkeeps(): void {
  const state = upkeepState()
  state.done.clear()
  state.running.clear()
  state.browserGeneration = 0
}

/**
 * Catches the vault up, once per process (and the browser again after an
 * install). One at a time per vault; what fails is logged without its
 * values and tried by the next process.
 */
export function catchUpVault(ctx: VaultContext): Promise<void> {
  const state = upkeepState()
  const seen = state.done.get(ctx.vaultId)

  if (seen === state.browserGeneration) {
    return Promise.resolve()
  }

  const under = state.running.get(ctx.vaultId)

  if (under) {
    return under
  }

  const generation = state.browserGeneration
  const run = (async () => {
    if (seen === undefined) {
      const { rebuildOutdatedEndpoints } = await import("./endpoints")

      try {
        const { rebuilt, failed } = await rebuildOutdatedEndpoints(ctx)

        if (rebuilt > 0) {
          console.log(`[endpoints] rebuilt the tools of ${rebuilt} endpoint(s)`)
        }

        for (const { serverId, message } of failed) {
          console.error("[endpoints] could not rebuild tools", {
            server: serverId,
            message,
          })
        }
      } catch {
        console.error("[endpoints] rebuild failed")
      }
    }

    const { syncVaultBrowserTools } = await import("./browser/server")

    try {
      await syncVaultBrowserTools(ctx)
    } catch {
      console.error("[browser] could not update the browser's tools")
    }

    state.done.set(ctx.vaultId, generation)
  })().finally(() => state.running.delete(ctx.vaultId))

  state.running.set(ctx.vaultId, run)
  return run
}
