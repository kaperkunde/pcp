import type { VaultContext } from "../context"
import { markedReadOnly } from "../read-only"
import { readPacingConfig, resolveBrowserPolicy, resolvePolicy } from "./config"
import {
  PACING_CALL_WAIT_MS,
  PACING_DEADLINE_MARGIN_MS,
  PACING_MAX_WAIT_MS,
  pacingOff,
  type BrowserPacingClass,
  type PaceRange,
  type PacingClass,
} from "./limits"
import {
  pacingNow,
  takeTurn,
  waitForSlot,
  type PacedRefusal,
  type Turn,
} from "./pace"

/**
 * One pacing for everything an assistant does (limits.ts says why), applied
 * at two places, which every way of calling passes, and to search's
 * embeddings requests (paceEmbeddings): upstream.ts
 * callServerTool for a server's tools (execute_<tier>, run_<tier>'s
 * pcp.call, a wrapper's calls, a call the owner allowed; the
 * browser's actions are paced inside browser/call.ts by the tab's site,
 * as a turn taken on the tab's lane: paceBrowserTurn),
 * and web fetch's request path (fetch/fetch.ts each request and redirect,
 * web-fetch.ts the read through the browser). Each answers null when the
 * action may go, after waiting for its turn, or a refusal (pacedResult
 * makes it the tool error) when its turn is further off than the caller
 * can wait.
 *
 * How long that is, is the caller's: a `deadline` on pacing's clock (epoch
 * milliseconds), the run's end for a run_code program's or a wrapper's
 * calls (code/run.ts CallRun), callDeadline() for a call straight from an
 * assistant's request or the owner's answer. A call waits up to the
 * deadline less PACING_DEADLINE_MARGIN_MS, and never past its signal.
 */

export type { BrowserPacingClass, PacingClass } from "./limits"
export {
  pacedResult,
  pacedRetryAfter,
  type PacedRefusal,
  type Turn,
} from "./pace"

/** The options every pacing call takes. */
export type PaceOptions = {
  /** Aborts the wait (the run ended); its slot is given back. */
  signal?: AbortSignal
  /** The latest the call may still go, in epoch milliseconds. */
  deadline?: number
}

/**
 * The deadline of a call made straight from an assistant's request (execute_<tier>,
 * web_fetch) or from the owner's answer to one: its wait
 * comes to PACING_CALL_WAIT_MS at most.
 */
export function callDeadline(): number {
  return pacingNow() + PACING_CALL_WAIT_MS + PACING_DEADLINE_MARGIN_MS
}

function serverKey(vaultId: string, serverId: string): string {
  return `${vaultId}\nserver:${serverId}`
}

function siteKey(vaultId: string, host: string): string {
  return `${vaultId}\nsite:${host}`
}

/**
 * A call to a server's tool, paced by the server: one in the Read tier
 * (tool-tiers.ts, through read-only.ts), or one that changes things.
 */
export async function paceServerCall(
  ctx: VaultContext,
  server: { id: string; name: string },
  toolName: string,
  { signal, deadline }: PaceOptions = {},
): Promise<PacedRefusal | null> {
  if (pacingOff()) {
    return null
  }

  const pacingClass: PacingClass = (await markedReadOnly(
    ctx,
    server.id,
    toolName,
  ))
    ? "server_read"
    : "server_change"
  const policy = resolvePolicy(await readPacingConfig(ctx), pacingClass, {
    serverId: server.id,
  })

  if (!policy) {
    return null
  }

  return waitForSlot(serverKey(ctx.vaultId, server.id), server.name, policy, {
    signal,
    deadline,
  })
}

/**
 * A request to search's embeddings provider (lib/core/embeddings/), which
 * PCP makes for a search, not an assistant's action, but which a busy
 * assistant's searches would otherwise send as fast as it searches: paced
 * as a read, by the endpoint it goes to (with that server's own calls and
 * its override) or else by the vault's provider.
 */
export async function paceEmbeddings(
  ctx: VaultContext,
  provider: { serverId?: string; name: string },
  { signal, deadline }: PaceOptions = {},
): Promise<PacedRefusal | null> {
  if (pacingOff()) {
    return null
  }

  const policy = resolvePolicy(await readPacingConfig(ctx), "server_read", {
    serverId: provider.serverId,
  })

  if (!policy) {
    return null
  }

  return waitForSlot(
    provider.serverId
      ? serverKey(ctx.vaultId, provider.serverId)
      : `${ctx.vaultId}\nembeddings`,
    provider.name,
    policy,
    { signal, deadline },
  )
}

/**
 * The deadline a browser action's turn waits to: the caller's, but never
 * past PACING_MAX_WAIT_MS from now, as the turn is waited for while the
 * call holds its tab (browser/limits.ts PACED_TURN_WAIT_MS).
 */
export function browserTurnDeadline(deadline: number | undefined): number {
  const most = pacingNow() + PACING_MAX_WAIT_MS + PACING_DEADLINE_MARGIN_MS
  return deadline === undefined ? most : Math.min(deadline, most)
}

/** A turn that holds nothing back: pacing is off, or the site unpaced. */
const NO_TURN: Turn = { release: () => {} }

/**
 * A browser action's turn at its site (browser/call.ts, on the tab's lane,
 * right before the action): one action at a site at a time, across its
 * tabs, each after the previous one ended and its pause went by (takeTurn).
 * `own` is the action's own pace: its tab's, else its wrapper's
 * (resolveBrowserPolicy). Release it when the action is done.
 */
export async function paceBrowserTurn(
  ctx: VaultContext,
  host: string,
  pacingClass: BrowserPacingClass,
  {
    serverId,
    own,
    signal,
    deadline,
  }: PaceOptions & { serverId?: string; own?: PaceRange | null } = {},
): Promise<PacedRefusal | Turn> {
  if (pacingOff() || !host) {
    return NO_TURN
  }

  const policy = resolveBrowserPolicy(
    await readPacingConfig(ctx),
    pacingClass,
    { site: host, serverId, own },
  )

  if (!policy) {
    return NO_TURN
  }

  return takeTurn(siteKey(ctx.vaultId, host), host, policy, {
    signal,
    deadline,
  })
}

/** A web fetch request to a site. */
export async function paceSite(
  ctx: VaultContext,
  host: string,
  pacingClass: Extract<PacingClass, "web_fetch">,
  { serverId, signal, deadline }: PaceOptions & { serverId?: string } = {},
): Promise<PacedRefusal | null> {
  if (pacingOff() || !host) {
    return null
  }

  const policy = resolvePolicy(await readPacingConfig(ctx), pacingClass, {
    site: host,
    serverId,
  })

  if (!policy) {
    return null
  }

  return waitForSlot(siteKey(ctx.vaultId, host), host, policy, {
    signal,
    deadline,
  })
}

export { browserPacingClass } from "./limits"
