import type { Prisma } from "@/lib/generated/prisma/client"

import { handoverTabOf } from "./browser/runtime"
import type { PermissionKind } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { repoChangeHref } from "./repos/notices"
import { listRepoItems } from "./repos/store"

/**
 * What waits for the owner's answer, in the one order every list of it
 * uses: oldest first. The bell, Home, a token's page and the walk from one
 * answered request to the next (`nextPendingRequest`) all read requests
 * through `waitingRequestsWhere` and `WAITING_ORDER`, so they agree on what
 * is waiting and which comes first.
 *
 * The queue is the requests from assistants and the changes linked
 * repositories left for review, by when each started waiting. PCP's own
 * notices (owner-notices.ts) are not in it: they are things to look at, not
 * to answer.
 */

/**
 * Requests the owner can still answer: pending, not expired, and from a
 * token that is neither revoked nor expired (a dead token's requests can no
 * longer be answered, so they wait for nobody).
 */
export function waitingRequestsWhere(
  ctx: VaultContext,
  { tokenId, now = new Date() }: { tokenId?: string; now?: Date } = {},
): Prisma.PermissionRequestWhereInput {
  return {
    vaultId: ctx.vaultId,
    ...(tokenId ? { tokenId } : {}),
    status: "pending",
    expiresAt: { gt: now },
    token: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  }
}

/** Oldest first; the id settles two made in the same millisecond. */
export const WAITING_ORDER: Prisma.PermissionRequestOrderByWithRelationInput[] =
  [{ createdAt: "asc" }, { id: "asc" }]

/** One thing in the owner's queue. */
export type QueueEntry =
  | {
      source: "request"
      id: string
      kind: PermissionKind
      since: Date
      /** A hand-over's tab, while it is open (`handoverTab`). */
      tabId: string | null
    }
  | {
      source: "repo"
      /** The linked item's id. */
      id: string
      since: Date
    }

/**
 * Where the owner answers an entry. The one place that says so: the bell,
 * Home and the walk to the next request all link through it. A hand-over
 * is answered on its tab, in the Browser page's tabs view, while the tab is
 * open (`tabId`); once it is gone, on the request's own page, which says
 * how it ended.
 */
export function queueHref(
  entry: Pick<QueueEntry, "source" | "id"> & {
    kind?: PermissionKind
    tabId?: string | null
  },
): string {
  if (entry.source === "repo") {
    return repoChangeHref(entry.id)
  }

  if (entry.kind === "browser_handover" && entry.tabId) {
    return `/browser?tab=${encodeURIComponent(entry.tabId)}`
  }

  return `/permissions/${encodeURIComponent(entry.id)}`
}

/**
 * The open tab a request is about, for `queueHref`: a hand-over's, while
 * its tab is open in the vault's browser; null for any other request.
 */
export function handoverTab(
  ctx: VaultContext,
  request: { id: string; kind: string },
): string | null {
  return request.kind === "browser_handover"
    ? handoverTabOf(ctx.vaultId, request.id)
    : null
}

/** The changes linked repositories left for the owner, oldest first. */
async function waitingRepoChanges(ctx: VaultContext): Promise<QueueEntry[]> {
  const waiting = await db().repoItem.count({
    where: {
      repo: { vaultId: ctx.vaultId },
      state: { in: ["review", "conflict"] },
    },
  })

  if (waiting === 0) {
    return []
  }

  return (await listRepoItems(ctx)).flatMap((item) =>
    item.data.pending
      ? [
          {
            source: "repo" as const,
            id: item.id,
            since: new Date(item.data.pending.foundAt),
          },
        ]
      : [],
  )
}

function bySince(a: QueueEntry, b: QueueEntry): number {
  return (
    a.since.getTime() - b.since.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * The owner's queue, oldest first, leaving out `skip` (the one just
 * answered, which may still read as waiting for a moment) and taking at
 * most `limit` of each source.
 */
export async function ownerQueue(
  ctx: VaultContext,
  { skip, limit }: { skip?: string; limit?: number } = {},
): Promise<QueueEntry[]> {
  const [requests, repos] = await Promise.all([
    db().permissionRequest.findMany({
      where: {
        ...waitingRequestsWhere(ctx),
        ...(skip ? { id: { not: skip } } : {}),
      },
      select: { id: true, kind: true, createdAt: true },
      orderBy: WAITING_ORDER,
      ...(limit ? { take: limit } : {}),
    }),
    waitingRepoChanges(ctx),
  ])

  return [
    ...requests.map((row) => ({
      source: "request" as const,
      id: row.id,
      kind: row.kind as PermissionKind,
      since: row.createdAt,
      tabId: handoverTab(ctx, row),
    })),
    ...repos.filter((entry) => entry.id !== skip).slice(0, limit),
  ].sort(bySince)
}

/**
 * Where the owner goes after answering `afterId`: the oldest thing still
 * waiting other than it, or null when nothing is. Only an address: the
 * owner answers it there, as they would from the bell.
 */
export async function nextPendingRequest(
  ctx: VaultContext,
  afterId?: string,
): Promise<string | null> {
  const [first] = await ownerQueue(ctx, { skip: afterId, limit: 1 })

  return first ? queueHref(first) : null
}
