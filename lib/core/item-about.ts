import type { VaultContext } from "./context"
import { db } from "./db"
import { canClone, definitionOf } from "./definitions"
import { isPcpError, notFound } from "./errors"
import { readServerNote, readSkillNote } from "./personal-notes"
import { localHash } from "./repos/hash"
import type { ItemKind } from "./repos/layout"
import type { SyncFrequency } from "./repos/limits"
import { itemKindOfServer, localItem } from "./repos/local"
import { repoChangeHref } from "./repos/notices"
import { githubPathUrl } from "./repos/overview"
import {
  findRepoItem,
  getRepo,
  listRepos,
  type RepoItemRow,
  type RepoItemState,
} from "./repos/store"

/**
 * What an item's About card says (a server's, an endpoint's, a wrapper's or
 * a skill's page): what kind of thing it is and which definition, where it
 * came from, how it syncs, whether it is shared, the other servers of its
 * definition, and the owner's note.
 *
 * Source, Sync and Sharing read the item's link to a repository (a
 * server's is its definition's: any instance's link counts): where it is
 * there, where it stands with it, and whether anyone can read it there.
 */

export type ItemKindForAbout = "server" | "skill"

export type ItemSource =
  | { kind: "local" }
  | {
      kind: "repo"
      repoId: string
      /** owner/name on GitHub. */
      repo: string
      /** The item's folder or file in it. */
      path: string
      /** Added from a repository PCP does not push to. */
      imported: boolean
      /** The commit it is at (short), or the branch when PCP does not know it. */
      ref: string
      /** The item on GitHub. */
      url: string
    }

/** Where a linked item stands with its repository, in the owner's words. */
export type SyncStatus =
  "synced" | "pending_review" | "modified" | "update_available" | "error"

export type ItemSync =
  | { kind: "local" }
  | {
      kind: "linked"
      /** The link's id, for Sync now. */
      linkId: string
      repoId: string
      status: SyncStatus
      state: RepoItemState
      frequency: SyncFrequency
      lastSyncAt: Date | null
      /** Local changes are pushed too. */
      bidirectional: boolean
      /** The repository is the owner's to push to. */
      writable: boolean
      /** What the last sync said, when it is worth a line. */
      note: string | null
      /** The page that answers a waiting change, when one waits. */
      changeHref: string | null
    }

/**
 * Whether anyone else reads the item: public while it is in a repository
 * GitHub says anyone can read; private otherwise.
 */
export type ItemSharing = {
  kind: "private" | "public"
  /** The repository it is in, owner/name, if any. */
  repo: string | null
  /** What it is as an item of a repository; null for what PCP never shares. */
  itemKind: ItemKind | null
  /** Public repositories the owner pushes to, where Share can put it. */
  targets: Array<{ repoId: string; repo: string }>
}

export type ItemAbout = {
  itemKind: ItemKindForAbout
  id: string
  /** mcp, openapi, wrapper, jmap… for a server; "skill" for a skill. */
  kind: string
  /** The definition a server is an instance of; null for a skill and the kinds without one. */
  definition: { id: string; slug: string; name: string } | null
  /** Every server of the definition, this one among them, oldest first. */
  instances: Array<{ id: string; name: string; slug: string }>
  canClone: boolean
  source: ItemSource
  sync: ItemSync
  sharing: ItemSharing
  note: string | null
}

type Link = RepoItemRow | null

async function linkOf(
  ctx: VaultContext,
  kind: ItemKindForAbout,
  id: string,
): Promise<Link> {
  return findRepoItem(ctx, kind === "skill" ? "skill" : "server", id)
}

async function sourceOf(
  ctx: VaultContext,
  link: Link,
  itemKind: ItemKind | null,
): Promise<ItemSource> {
  if (!link) {
    return { kind: "local" }
  }

  const repo = await getRepo(ctx, link.repoId)
  const commit = link.data.commit ?? null

  return {
    kind: "repo",
    repoId: link.repoId,
    repo: `${repo.owner}/${repo.name}`,
    path: link.data.path,
    imported: repo.access === "read",
    ref: commit ? commit.slice(0, 7) : repo.branch,
    url: githubPathUrl(repo, link.data.path, itemKind ?? link.kind, commit),
  }
}

/** Whether the vault's item changed since it last agreed with the repository. */
async function changedHere(
  ctx: VaultContext,
  link: RepoItemRow,
): Promise<boolean> {
  try {
    const local = await localItem(ctx, link.kind, link.itemId)
    return localHash(local.document) !== link.data.localHash
  } catch (error) {
    if (isPcpError(error)) {
      return false
    }

    throw error
  }
}

async function syncOf(ctx: VaultContext, link: Link): Promise<ItemSync> {
  if (!link) {
    return { kind: "local" }
  }

  const repo = await getRepo(ctx, link.repoId)
  const state = link.state as RepoItemState
  const writable = repo.access === "write"
  let status: SyncStatus

  if (state === "error" || state === "missing") {
    status = "error"
  } else if (link.data.pending) {
    status = writable ? "pending_review" : "update_available"
  } else if (state === "local" || (await changedHere(ctx, link))) {
    status = "modified"
  } else {
    status = "synced"
  }

  return {
    kind: "linked",
    linkId: link.id,
    repoId: link.repoId,
    status,
    state,
    frequency: link.frequency as SyncFrequency,
    lastSyncAt: link.lastSyncAt,
    bidirectional: link.bidirectional,
    writable,
    note: link.data.note,
    changeHref: link.data.pending ? repoChangeHref(link.id) : null,
  }
}

async function sharingOf(
  ctx: VaultContext,
  link: Link,
  itemKind: ItemKind | null,
): Promise<ItemSharing> {
  const repos = await listRepos(ctx)
  const targets = itemKind
    ? repos
        .filter(
          (repo) => repo.access === "write" && repo.visibility === "public",
        )
        .map((repo) => ({
          repoId: repo.id,
          repo: `${repo.owner}/${repo.name}`,
        }))
    : []
  const repo = link ? repos.find((each) => each.id === link.repoId) : null

  return {
    kind: repo?.visibility === "public" ? "public" : "private",
    repo: repo ? `${repo.owner}/${repo.name}` : null,
    itemKind,
    targets,
  }
}

/** What a server row is as an item of a repository, flow or not. */
async function serverItemKind(
  ctx: VaultContext,
  id: string,
  kind: string,
): Promise<ItemKind | null> {
  const asItem = itemKindOfServer(kind)

  if (asItem !== "wrapper") {
    return asItem
  }

  try {
    return (await localItem(ctx, "wrapper", id)).document.kind
  } catch (error) {
    if (isPcpError(error)) {
      return null
    }

    throw error
  }
}

/** The About card of one server or skill of this vault. */
export async function itemAbout(
  ctx: VaultContext,
  itemKind: ItemKindForAbout,
  id: string,
): Promise<ItemAbout> {
  const link = await linkOf(ctx, itemKind, id)

  if (itemKind === "skill") {
    const skill = await db().skill.findFirst({
      where: { id, vaultId: ctx.vaultId },
      select: { id: true, personalNote: true },
    })

    if (!skill) {
      throw notFound("That skill")
    }

    return {
      itemKind,
      id,
      kind: "skill",
      definition: null,
      instances: [],
      canClone: false,
      source: await sourceOf(ctx, link, "skill"),
      sync: await syncOf(ctx, link),
      sharing: await sharingOf(ctx, link, "skill"),
      note: readSkillNote(ctx, skill),
    }
  }

  const server = await db().mcpServer.findFirst({
    where: { id, vaultId: ctx.vaultId },
    select: { id: true, kind: true, personalNote: true },
  })

  if (!server) {
    throw notFound("That server")
  }

  const definition = await definitionOf(ctx, id)
  const asItem = await serverItemKind(ctx, id, server.kind)

  return {
    itemKind,
    id,
    kind: server.kind,
    definition: definition && {
      id: definition.id,
      slug: definition.slug,
      name: definition.name,
    },
    instances: (definition?.instances ?? []).map(({ id, name, slug }) => ({
      id,
      name,
      slug,
    })),
    canClone: canClone(server.kind),
    source: await sourceOf(ctx, link, asItem),
    sync: await syncOf(ctx, link),
    sharing: await sharingOf(ctx, link, asItem),
    note: readServerNote(ctx, server),
  }
}
