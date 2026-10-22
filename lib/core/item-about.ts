import type { VaultContext } from "./context"
import { db } from "./db"
import { canClone, definitionOf } from "./definitions"
import { notFound } from "./errors"
import { readServerNote, readSkillNote } from "./personal-notes"
import type { SyncFrequency } from "./repos/limits"
import { findRepoItem, getRepo, type RepoItemState } from "./repos/store"

/**
 * What an item's About card says (a server's, an endpoint's, a wrapper's or
 * a skill's page): what kind of thing it is and which definition, where it
 * came from, how it syncs, whether it is shared, the other servers of its
 * definition, and the owner's note.
 *
 * Source, Sync and Sharing read what linked repositories hold today; the
 * repository work extends `sourceOf`, `syncOf` and `sharingOf` without the
 * pages changing shape.
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
    }

export type ItemSync =
  | { kind: "local" }
  | {
      kind: "linked"
      state: RepoItemState
      frequency: SyncFrequency
      lastSyncAt: Date | null
      /** Local changes are pushed too. */
      bidirectional: boolean
    }

/** Whether anyone else reads the item. Private until it is shared. */
export type ItemSharing = { kind: "private" }

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

async function linkOf(ctx: VaultContext, kind: ItemKindForAbout, id: string) {
  return findRepoItem(ctx, kind === "skill" ? "skill" : "server", id)
}

async function sourceOf(
  ctx: VaultContext,
  link: Awaited<ReturnType<typeof linkOf>>,
): Promise<ItemSource> {
  if (!link) {
    return { kind: "local" }
  }

  const repo = await getRepo(ctx, link.repoId)

  return {
    kind: "repo",
    repoId: link.repoId,
    repo: `${repo.owner}/${repo.name}`,
    path: link.data.path,
  }
}

function syncOf(link: Awaited<ReturnType<typeof linkOf>>): ItemSync {
  return link
    ? {
        kind: "linked",
        state: link.state as RepoItemState,
        frequency: link.frequency as SyncFrequency,
        lastSyncAt: link.lastSyncAt,
        bidirectional: link.bidirectional,
      }
    : { kind: "local" }
}

function sharingOf(): ItemSharing {
  return { kind: "private" }
}

/** The About card of one server or skill of this vault. */
export async function itemAbout(
  ctx: VaultContext,
  itemKind: ItemKindForAbout,
  id: string,
): Promise<ItemAbout> {
  const link = await linkOf(ctx, itemKind, id)
  const [source, sync, sharing] = [
    await sourceOf(ctx, link),
    syncOf(link),
    sharingOf(),
  ]

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
      source,
      sync,
      sharing,
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
    source,
    sync,
    sharing,
    note: readServerNote(ctx, server),
  }
}
