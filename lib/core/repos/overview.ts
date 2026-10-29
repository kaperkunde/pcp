import type { VaultContext } from "../context"

import { localHash } from "./hash"
import { itemRoot, type ItemKind } from "./layout"
import { GITHUB_WEB_URL } from "./limits"
import { localItems } from "./local"
import { refOf } from "./documents"
import {
  exclusionKey,
  getRepo,
  listExclusions,
  listRepoItems,
  listRepos,
  type RepoItemState,
  type RepoView,
} from "./store"

/**
 * One linked repository as its page shows it: every shareable item of the
 * vault, grouped by kind, each with where it stands with this repository.
 *
 * - Pushed: in it and in step.
 * - Changed: in it, with changes in the vault not pushed yet.
 * - Not pushed: only in the vault (a read-and-write repository's).
 * - Imported: added from it (a read-only repository's), with an update
 *   available when the repository has a newer one.
 * - Excluded: kept out of it on purpose, until the owner includes it again.
 */

export type ItemStatus =
  "pushed" | "changed" | "not_pushed" | "imported" | "excluded"

export const ITEM_STATUSES: readonly ItemStatus[] = [
  "pushed",
  "changed",
  "not_pushed",
  "imported",
  "excluded",
]

export type ItemGroup = "servers" | "wrappers" | "skills" | "flows"

export const ITEM_GROUPS: readonly ItemGroup[] = [
  "servers",
  "wrappers",
  "skills",
  "flows",
]

export function groupOf(kind: ItemKind): ItemGroup {
  switch (kind) {
    case "server":
    case "endpoint":
      return "servers"
    case "wrapper":
      return "wrappers"
    case "flow":
      return "flows"
    case "skill":
      return "skills"
  }
}

export type OverviewRow = {
  kind: ItemKind
  /** The skill's id, or the server row standing for the definition. */
  id: string
  /** Its short name in a repository, and its name. */
  name: string
  displayName: string
  /** Its page in PCP. */
  href: string
  status: ItemStatus
  /** Its folder (or file) in the repository, or where it would go. */
  path: string
  /** Its link to this repository, when it has one. */
  link: {
    id: string
    state: RepoItemState
    /** A change from the repository waits for the owner. */
    waiting: "review" | "conflict" | null
    commit: string | null
    lastSyncAt: Date | null
    note: string | null
    frequency: string
    bidirectional: boolean
  } | null
  /** The other repository it is linked to, owner/name, if any. */
  linkedElsewhere: string | null
}

export type RepoOverview = {
  repo: RepoView
  rows: OverviewRow[]
  counts: Record<ItemStatus, number>
  /** Items PCP could not read as documents, and why. */
  skipped: Array<{ id: string; name: string; message: string }>
}

/** Where an item's folder (or a server's file) is on GitHub. */
export function githubPathUrl(
  repo: Pick<RepoView, "owner" | "name" | "branch">,
  path: string,
  kind: ItemKind,
  at?: string | null,
): string {
  const base = `${GITHUB_WEB_URL}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  const ref = encodeURIComponent(at ?? repo.branch)
  const place = path.split("/").map(encodeURIComponent).join("/")

  return `${base}/${kind === "server" ? "blob" : "tree"}/${ref}/${place}`
}

/** A commit on GitHub. */
export function githubCommitUrl(
  repo: Pick<RepoView, "owner" | "name">,
  commit: string,
): string {
  return `${GITHUB_WEB_URL}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commit/${encodeURIComponent(commit)}`
}

export async function repoOverview(
  ctx: VaultContext,
  repoId: string,
): Promise<RepoOverview> {
  const repo = await getRepo(ctx, repoId)
  const skipped: RepoOverview["skipped"] = []
  const [items, links, excluded, repos] = await Promise.all([
    localItems(ctx, skipped),
    listRepoItems(ctx),
    listExclusions(ctx, repoId),
    listRepos(ctx),
  ])
  const repoNames = new Map(
    repos.map((each) => [each.id, `${each.owner}/${each.name}`]),
  )
  const rows: OverviewRow[] = []

  for (const item of items) {
    const { document } = item
    const link = links.find((entry) => entry.itemId === item.id) ?? null
    const here = link && link.repoId === repoId ? link : null
    let status: ItemStatus

    if (here) {
      if (repo.access === "read") {
        status = "imported"
      } else {
        const changed =
          here.state === "local" || localHash(document) !== here.data.localHash
        status = changed ? "changed" : "pushed"
      }
    } else if (excluded.has(await exclusionKey(ctx, document.kind, item.id))) {
      status = "excluded"
    } else if (repo.access === "write") {
      status = "not_pushed"
    } else {
      // A read-only repository's page lists what came from it.
      continue
    }

    rows.push({
      kind: document.kind,
      id: item.id,
      name: document.name,
      displayName:
        document.kind === "skill" ? document.name : document.displayName,
      href:
        document.kind === "skill"
          ? `/skills/${item.id}`
          : `/servers/${item.id}`,
      status,
      path: here?.data.path ?? itemRoot(refOf(document)),
      link: here
        ? {
            id: here.id,
            state: here.state as RepoItemState,
            waiting: here.data.pending?.kind ?? null,
            commit: here.data.commit ?? null,
            lastSyncAt: here.lastSyncAt,
            note: here.data.note,
            frequency: here.frequency,
            bidirectional: here.bidirectional,
          }
        : null,
      linkedElsewhere:
        link && !here ? (repoNames.get(link.repoId) ?? null) : null,
    })
  }

  const counts = Object.fromEntries(
    ITEM_STATUSES.map((status) => [
      status,
      rows.filter((row) => row.status === status).length,
    ]),
  ) as Record<ItemStatus, number>

  return { repo, rows, counts, skipped }
}
