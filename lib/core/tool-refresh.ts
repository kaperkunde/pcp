/**
 * An assistant asking for a server's tools to be read again now (check_server
 * `refresh`, kaperkunde/pcp#171). Pure rules and an in-memory pace; the read
 * itself is `syncServerTools`, the one path that also applies pending access,
 * so a refresh never grants anything.
 */
import { canRereadTools } from "./catalogue"

/** How often one server's tools may be read again on an assistant's ask. */
export const REFRESH_MIN_INTERVAL_MS = 60_000
const MAX_REMEMBERED_REFRESHES = 1_000

/** When each server was last refreshed by an assistant, in this process. */
const refreshedAt = new Map<string, number>()

/**
 * Why a server's tools are not read on an assistant's ask, or null when they
 * may be: it waits for the owner (sign in, a client, an SSH host key not
 * pinned yet), or its list does not change when read again.
 */
export function refreshBlockedReason(server: {
  kind: string
  specSource: string | null
  status: string
  sshHostKey?: string | null
}): string | null {
  if (
    server.status === "auth_required" ||
    server.status === "client_required"
  ) {
    return "it waits for the owner to connect it"
  }

  if (server.kind === "ssh" && !server.sshHostKey) {
    return "its host key is not pinned yet, which only the owner does"
  }

  if (!canRereadTools(server) || server.kind === "ssh") {
    return "its tools do not change when read again"
  }

  return null
}

/**
 * Takes the server's turn for a refresh: 0 when it may be read now (and the
 * turn is spent), else the milliseconds until it may.
 */
export function claimRefresh(serverId: string, now = Date.now()): number {
  const last = refreshedAt.get(serverId)

  if (last !== undefined && now - last < REFRESH_MIN_INTERVAL_MS) {
    return REFRESH_MIN_INTERVAL_MS - (now - last)
  }

  if (refreshedAt.size >= MAX_REMEMBERED_REFRESHES) {
    refreshedAt.clear()
  }
  refreshedAt.set(serverId, now)

  return 0
}

/** Tool names that appeared and went away between two lists. */
export function diffToolNames(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const was = new Set(before)
  const is = new Set(after)

  return {
    added: [...is].filter((name) => !was.has(name)).sort(),
    removed: [...was].filter((name) => !is.has(name)).sort(),
  }
}

/** For tests. */
export function resetRefreshes(): void {
  refreshedAt.clear()
}
