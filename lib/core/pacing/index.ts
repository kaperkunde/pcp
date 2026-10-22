import { markedReadOnly } from "../read-only"
import { readPacingConfig, resolvePolicy } from "./config"
import { pacingOff, UNPACED_BROWSER_TOOLS, type PacingClass } from "./limits"
import { waitForSlot } from "./pace"

/**
 * One pacing for everything an assistant does (limits.ts says why), applied
 * at two places only, which every way of calling passes: upstream.ts
 * callServerTool for a server's tools (call_tool and call_read_only_tool,
 * run_code's pcp.call, a wrapper's calls, a call the owner allowed; the
 * browser's actions are paced inside browser/call.ts by the tab's site),
 * and web fetch's request path (fetch/fetch.ts each request and redirect,
 * web-fetch.ts the read through the browser). Each answers null when the
 * action may go, after waiting for its turn, or the tool error to answer
 * with when its turn is too far off.
 */

export type { PacingClass } from "./limits"

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
  { signal }: { signal?: AbortSignal } = {},
): Promise<string | null> {
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
  { serverId, signal }: { serverId?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
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

  return waitForSlot(siteKey(vaultId, host), host, policy, { signal })
}

/** Whether a browser tool is paced: the ones that act on the page. */
export function browserToolPaced(toolName: string): boolean {
  return !UNPACED_BROWSER_TOOLS.has(toolName)
}
