import { markedReadOnly } from "../read-only"
import { readPacingConfig, resolvePolicy } from "./config"
import {
  PACING_CALL_WAIT_MS,
  PACING_DEADLINE_MARGIN_MS,
  pacingOff,
  UNPACED_BROWSER_TOOLS,
  type PacingClass,
} from "./limits"
import { pacingNow, waitForSlot, type PacedRefusal } from "./pace"

/**
 * One pacing for everything an assistant does (limits.ts says why), applied
 * at two places only, which every way of calling passes: upstream.ts
 * callServerTool for a server's tools (call_tool and call_read_only_tool,
 * run_code's pcp.call, a wrapper's calls, a call the owner allowed; the
 * browser's actions are paced inside browser/call.ts by the tab's site),
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

export type { PacingClass } from "./limits"
export { pacedResult, pacedRetryAfter, type PacedRefusal } from "./pace"

/** The options every pacing call takes. */
export type PaceOptions = {
  /** Aborts the wait (the run ended); its slot is given back. */
  signal?: AbortSignal
  /** The latest the call may still go, in epoch milliseconds. */
  deadline?: number
}

/**
 * The deadline of a call made straight from an assistant's request (call_tool,
 * call_read_only_tool, web_fetch) or from the owner's answer to one: its wait
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
 * A call to a server's tool, paced by the server: one that changes things,
 * or one its server marks read-only (read-only.ts).
 */
export async function paceServerCall(
  vaultId: string,
  server: { id: string; name: string },
  toolName: string,
  { signal, deadline }: PaceOptions = {},
): Promise<PacedRefusal | null> {
  if (pacingOff()) {
    return null
  }

  const pacingClass: PacingClass = (await markedReadOnly(server.id, toolName))
    ? "server_read"
    : "server_change"
  const policy = resolvePolicy(await readPacingConfig(vaultId), pacingClass, {
    serverId: server.id,
  })

  if (!policy) {
    return null
  }

  return waitForSlot(serverKey(vaultId, server.id), server.name, policy, {
    signal,
    deadline,
  })
}

/**
 * An action on a site: a web fetch request, or a browser action on the
 * tab's site (the browser's own server id given, for its override).
 */
export async function paceSite(
  vaultId: string,
  host: string,
  pacingClass: Extract<PacingClass, "browser_act" | "web_fetch">,
  { serverId, signal, deadline }: PaceOptions & { serverId?: string } = {},
): Promise<PacedRefusal | null> {
  if (pacingOff() || !host) {
    return null
  }

  const policy = resolvePolicy(await readPacingConfig(vaultId), pacingClass, {
    site: host,
    serverId,
  })

  if (!policy) {
    return null
  }

  return waitForSlot(siteKey(vaultId, host), host, policy, {
    signal,
    deadline,
  })
}

/** Whether a browser tool is paced: the ones that act on the page. */
export function browserToolPaced(toolName: string): boolean {
  return !UNPACED_BROWSER_TOOLS.has(toolName)
}
