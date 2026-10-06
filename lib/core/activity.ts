import type { VaultContext } from "./context"
import { db } from "./db"
import { MAX_LOG_SEARCH_CHARS } from "./log-limits"
import {
  readRequestLog,
  type LoggedCall,
  type LogOutcome,
  type LogQuery,
} from "./request-log"

/**
 * The Log page: the vault's lines of the request log, with what the log
 * itself does not hold (it keeps ids, never names) filled in from the
 * database: each token's name, and how a request the call made was answered.
 */

/** Where a permission request a call made stands now. */
export type RequestState =
  "waiting" | "running" | "allowed" | "failed" | "declined" | "expired"

export type ActivityEntry = LoggedCall & {
  /** The token's name, or null for one deleted since. */
  tokenName: string | null
  /** The request it made, while PCP still keeps it. */
  requestState: RequestState | null
}

export type ActivityToken = {
  id: string
  name: string
  revoked: boolean
}

export type ActivityPage = {
  entries: ActivityEntry[]
  next: string | null
  /** For the filter: the vault's tokens, revoked ones included. */
  tokens: ActivityToken[]
}

const OUTCOMES: readonly LogOutcome[] = ["ok", "error", "asked"]

/** A query as the page's address has it, kept to what it may be. */
export function readActivityQuery(
  params: Record<string, string | string[] | undefined>,
): LogQuery {
  const one = (key: string) => {
    const value = params[key]
    return typeof value === "string" ? value : undefined
  }
  const outcome = one("outcome")
  const text = one("q")?.trim().slice(0, MAX_LOG_SEARCH_CHARS)

  return {
    tokenId: one("token") || undefined,
    outcome: OUTCOMES.includes(outcome as LogOutcome)
      ? (outcome as LogOutcome)
      : undefined,
    text: text || undefined,
    cursor: one("before") || undefined,
  }
}

function stateOf(
  row: { status: string; expiresAt: Date },
  now: Date,
): RequestState {
  switch (row.status) {
    case "executed":
      return "allowed"
    case "running":
    case "failed":
    case "declined":
      return row.status
    default:
      return row.expiresAt > now ? "waiting" : "expired"
  }
}

export async function activityLog(
  ctx: VaultContext,
  query: LogQuery,
  now = new Date(),
): Promise<ActivityPage> {
  const [page, tokens] = await Promise.all([
    readRequestLog(ctx.vaultId, query),
    db().apiToken.findMany({
      where: { vaultId: ctx.vaultId },
      select: { id: true, name: true, revokedAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ])
  const requestIds = [
    ...new Set(
      page.entries.flatMap((entry) => (entry.request ? [entry.request] : [])),
    ),
  ]
  const requests =
    requestIds.length > 0
      ? await db().permissionRequest.findMany({
          where: { vaultId: ctx.vaultId, id: { in: requestIds } },
          select: { id: true, status: true, expiresAt: true },
        })
      : []
  const names = new Map(tokens.map((token) => [token.id, token.name]))
  const states = new Map(
    requests.map((request) => [request.id, stateOf(request, now)]),
  )

  return {
    entries: page.entries.map((entry) => ({
      ...entry,
      tokenName: names.get(entry.tokenId) ?? null,
      requestState: entry.request ? (states.get(entry.request) ?? null) : null,
    })),
    next: page.next,
    tokens: tokens.map((token) => ({
      id: token.id,
      name: token.name,
      revoked: token.revokedAt !== null,
    })),
  }
}
