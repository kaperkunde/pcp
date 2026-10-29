import type { VaultContext } from "../context"
import { db } from "../db"

import { listRepoItems, readRepoState } from "./store"

/**
 * The bell's notices for linked repositories (owner-notices.ts): each item
 * with a change waiting for the owner's review, and each conflict, worked
 * out from the items' states when the bell is read.
 */

export type RepoNotice = {
  id: string
  kind: "repos"
  title: string
  href: string
  detail: string
}

export function repoChangeHref(itemId: string): string {
  return `/settings/repositories/changes/${encodeURIComponent(itemId)}`
}

export async function repoNotices(ctx: VaultContext): Promise<RepoNotice[]> {
  const waiting = await db().repoItem.count({
    where: {
      repo: { vaultId: ctx.vaultId },
      state: { in: ["review", "conflict"] },
    },
  })

  if (waiting === 0) {
    return []
  }

  const repos = new Map(
    (await db().repo.findMany({ where: { vaultId: ctx.vaultId } })).map(
      (row) => [row.id, readRepoState(ctx, row)],
    ),
  )

  return (await listRepoItems(ctx))
    .filter((item) => item.data.pending !== null)
    .map((item) => {
      const repo = repos.get(item.repoId)
      const from = repo ? `${repo.owner}/${repo.name}` : "a repository"
      const conflict = item.data.pending!.kind === "conflict"

      return {
        // lib/pending-count.ts `repoNoticeId` drops it from the count once
        // the owner answers it: the two stay the same.
        id: `repo:${item.id}`,
        kind: "repos" as const,
        title: conflict
          ? `Conflict in ${item.data.path} with ${from}`
          : `Change to review in ${item.data.path} from ${from}`,
        href: repoChangeHref(item.id),
        detail: conflict
          ? "Keep yours, take theirs, or let an assistant help"
          : "Read every file and flag, then approve or not",
      }
    })
}
