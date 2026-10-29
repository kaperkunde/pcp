import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, isPcpError, PcpError } from "../errors"

import {
  applyItem,
  resolveItem,
  type InstanceInput,
  type ResolvedItem,
} from "./apply"
import type { ItemDocument } from "./documents"
import { commitAt, type GitHub } from "./github"
import { localHash } from "./hash"
import type { ItemRef } from "./layout"
import {
  MAX_SYNC_ITEMS_PER_RUN,
  SYNC_BUDGET_MS,
  SYNC_LOOK_INTERVAL_MS,
  SYNC_PERIOD_MS,
  type SyncFrequency,
} from "./limits"
import { findLocalItem, localItem, type LocalItem } from "./local"
import { pushDocument, type Proposer } from "./push"
import {
  fetchItem,
  fetchItemAt,
  listRemote,
  type FetchedItem,
  type RemoteListing,
} from "./remote"
import { reviewItem, type ItemReview } from "./review"
import {
  clientFor,
  getRepo,
  getRepoItem,
  linkItem,
  listRepoItems,
  refreshVisibility,
  saveItem,
  type Pending,
  type RepoItemData,
  type RepoItemRow,
  type RepoItemState,
  type RepoView,
} from "./store"

/**
 * Sync between a linked item and its place in the repository, by hash: the
 * git id of the item's folder (or file) against the one stored when the two
 * last agreed, and `localHash` of the vault's item against the one stored
 * then.
 *
 * - Neither changed: nothing.
 * - Only the repository's: it is pulled. From a trusted repository the owner
 *   pushes to (read and write), a change that is text only (review.ts
 *   `textOnly`) is applied at once; anything else, everything from an
 *   untrusted repository, and every change to an item imported from a
 *   read-only one, waits for the owner as a review (the item's `pending`,
 *   named by its git id): an import stays at the commit the owner reviewed
 *   until they take the update.
 * - Only the vault's, with two-way sync on: it is pushed. Otherwise it stays
 *   as a local change.
 * - Both: a conflict. Nothing is applied or pushed; the owner keeps theirs,
 *   takes the repository's, or has an assistant help.
 *
 * Nothing here runs by itself: no timer, no webhook, no stored key. A due
 * sync runs after a request that already holds the vault's key has been
 * answered (runDueSyncs), and the owner's Sync now runs one at once.
 */

export type SyncOutcome =
  | "same"
  | "pulled"
  | "pushed"
  | "review"
  | "conflict"
  | "local"
  | "missing"
  | "error"

export type SyncResult = { outcome: SyncOutcome; message: string }

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`
}

async function localOf(
  ctx: VaultContext,
  item: Pick<RepoItemRow, "kind" | "itemId">,
): Promise<LocalItem> {
  return localItem(ctx, item.kind, item.itemId)
}

function cleared(data: RepoItemData): RepoItemData {
  return { ...data, pending: null, drafts: {}, note: null }
}

/** Syncs one item, with the repository's listing when the caller has it. */
export async function syncItem(
  ctx: VaultContext,
  itemId: string,
  given: { gh?: GitHub; listing?: RemoteListing; repo?: RepoView } = {},
): Promise<SyncResult> {
  const item = await getRepoItem(ctx, itemId)
  const now = new Date()
  const save = (
    data: RepoItemData,
    state: RepoItemState,
    result: SyncResult,
  ): Promise<SyncResult> =>
    saveItem(ctx, item, data, { state, lastSyncAt: now }).then(() => result)

  try {
    const repo = given.repo ?? (await getRepo(ctx, item.repoId))
    const gh = given.gh ?? (await clientFor(ctx, repo))
    const listing = given.listing ?? (await listRemote(gh, repo, repo.branch))
    const remote = listing.items.find((entry) => entry.root === item.data.path)
    const local = await localOf(ctx, item)
    const localNow = localHash(local.document)
    const data = { ...item.data }

    if (!remote) {
      return save({ ...data, note: null }, "missing", {
        outcome: "missing",
        message: `${item.data.path} is no longer on ${repo.branch}, or it cannot be read as an item there.`,
      })
    }

    const remoteChanged = remote.sha !== data.remoteSha
    const localChanged = localNow !== data.localHash

    if (!remoteChanged && !localChanged) {
      return save(cleared(data), "ok", {
        outcome: "same",
        message: "Nothing changed.",
      })
    }

    if (!remoteChanged) {
      if (item.bidirectional && repo.access === "write") {
        const pushed = await pushDocument(gh, repo, local.document, {
          root: data.path,
          proposer: { by: "owner" },
        })

        return save(
          {
            ...cleared(data),
            remoteSha: pushed.sha,
            localHash: localNow,
            commit: pushed.commit ?? data.commit ?? null,
          },
          "ok",
          { outcome: "pushed", message: "Your change was pushed." },
        )
      }

      return save({ ...data, note: null }, "local", {
        outcome: "local",
        message: "Your change stays in your vault: two-way sync is off.",
      })
    }

    if (!localChanged && remote.sha === data.declinedSha) {
      return save(data, "ok", {
        outcome: "same",
        message: "You said no to this change; nothing new since.",
      })
    }

    const kind: Pending["kind"] = localChanged ? "conflict" : "review"

    if (
      data.pending?.sha === remote.sha &&
      data.pending.kind === kind &&
      data.pending.basis === localNow
    ) {
      return save(data, kind, {
        outcome: kind,
        message: "A change is waiting for you.",
      })
    }

    const fetched = await fetchItem(gh, repo, remote)
    const review = reviewItem(local.document, fetched.document)

    if (review.same) {
      return save(
        { ...cleared(data), remoteSha: remote.sha, localHash: localNow },
        "ok",
        { outcome: "same", message: "Both sides are the same again." },
      )
    }

    // Only from a repository the owner pushes to: an import is pinned.
    if (
      kind === "review" &&
      repo.trust === "trusted" &&
      repo.access === "write" &&
      review.textOnly
    ) {
      await applyItem(ctx, fetched.document, { id: item.itemId })
      const after = await localOf(ctx, item)

      return save(
        {
          ...cleared(data),
          remoteSha: remote.sha,
          localHash: localHash(after.document),
          declinedSha: null,
          commit: listing.head.commit,
        },
        "ok",
        {
          outcome: "pulled",
          message: "The repository's text change was applied.",
        },
      )
    }

    const pending: Pending = {
      kind,
      ref: fetched.item.ref,
      sha: remote.sha,
      hash: fetched.hash,
      commit: listing.head.commit,
      basis: localNow,
      flags: review.flags.length,
      foundAt: now.toISOString(),
    }

    return save({ ...data, pending, drafts: {}, note: null }, kind, {
      outcome: kind,
      message:
        kind === "conflict"
          ? "Both your vault and the repository changed it: nothing was applied."
          : review.flags.length > 0
            ? `It changes ${plural(review.flags.length, "thing")} that reach further: it waits for you.`
            : repo.access !== "write"
              ? "An update is available: what you added stays as you reviewed it until you take it."
              : repo.trust === "trusted"
                ? "The change waits for you."
                : "The repository is not one you trust, so the change waits for you.",
    })
  } catch (error) {
    if (!isPcpError(error)) {
      throw error
    }

    await saveItem(
      ctx,
      item,
      { ...item.data, note: error.message },
      { state: "error", lastSyncAt: now },
    )

    return { outcome: "error", message: error.message }
  }
}

/** Every item of a repository, synced now, with one listing of it. */
export async function syncRepo(
  ctx: VaultContext,
  repoId: string,
): Promise<SyncResult[]> {
  const repo = await getRepo(ctx, repoId)
  const items = await listRepoItems(ctx, repoId)

  if (items.length === 0) {
    return []
  }

  const gh = await clientFor(ctx, repo)
  const listing = await listRemote(gh, repo, repo.branch)
  const fresh = await refreshVisibility(ctx, repo, gh)
  const results: SyncResult[] = []

  for (const item of items) {
    results.push(await syncItem(ctx, item.id, { gh, listing, repo: fresh }))
  }

  return results
}

// ---- Due syncs ------------------------------------------------------------------

const running = new Set<string>()
const lastLook = new Map<string, number>()

/** Tests: forget when each vault was last looked at. */
export function forgetSyncLooks(): void {
  lastLook.clear()
}

export function isDue(
  item: { frequency: string; lastSyncAt: Date | null },
  now: number,
): boolean {
  if (item.frequency === "off") {
    return false
  }

  const period = SYNC_PERIOD_MS[item.frequency as Exclude<SyncFrequency, "off">]

  return (
    period !== undefined &&
    (item.lastSyncAt === null || now - item.lastSyncAt.getTime() >= period)
  )
}

export type DueRun = {
  synced: number
  skipped?: "busy" | "recent"
}

/**
 * The syncs that are due, run now: after a request that holds the vault's
 * key was answered (app/mcp/route.ts, the owner's pages, through Next's
 * after()). One run per vault at a time, a few items within a short budget;
 * what it does not reach is due at the next request. Never throws: a
 * failure is the item's state.
 */
export async function runDueSyncs(
  ctx: VaultContext,
  {
    now = Date.now(),
    budgetMs = SYNC_BUDGET_MS,
  }: { now?: number; budgetMs?: number } = {},
): Promise<DueRun> {
  if (running.has(ctx.vaultId)) {
    return { synced: 0, skipped: "busy" }
  }

  if (now - (lastLook.get(ctx.vaultId) ?? -Infinity) < SYNC_LOOK_INTERVAL_MS) {
    return { synced: 0, skipped: "recent" }
  }

  running.add(ctx.vaultId)
  lastLook.set(ctx.vaultId, now)
  const started = Date.now()
  let synced = 0

  try {
    const rows = await db().repoItem.findMany({
      where: { repo: { vaultId: ctx.vaultId }, frequency: { not: "off" } },
      select: { id: true, repoId: true, frequency: true, lastSyncAt: true },
      orderBy: { lastSyncAt: "asc" },
    })
    const due = rows
      .filter((row) => isDue(row, now))
      .slice(0, MAX_SYNC_ITEMS_PER_RUN)
    const byRepo = new Map<string, string[]>()

    for (const row of due) {
      byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row.id])
    }

    for (const [repoId, ids] of byRepo) {
      if (Date.now() - started > budgetMs) {
        break
      }

      let given: { gh: GitHub; listing: RemoteListing; repo: RepoView } | null =
        null

      try {
        const repo = await getRepo(ctx, repoId)
        const gh = await clientFor(ctx, repo)
        const listing = await listRemote(gh, repo, repo.branch)
        given = { repo: await refreshVisibility(ctx, repo, gh), gh, listing }
      } catch (error) {
        if (!isPcpError(error)) {
          throw error
        }

        // The repository could not be read: each item says so, and is due
        // again only after its period.
        for (const id of ids) {
          const item = await getRepoItem(ctx, id)
          await saveItem(
            ctx,
            item,
            { ...item.data, note: error.message },
            { state: "error", lastSyncAt: new Date(now) },
          )
        }
        continue
      }

      for (const id of ids) {
        if (Date.now() - started > budgetMs) {
          break
        }

        await syncItem(ctx, id, given)
        synced += 1
      }
    }
  } catch (error) {
    console.error("[repos] a due sync failed", error)
  } finally {
    running.delete(ctx.vaultId)
  }

  return { synced }
}

// ---- The owner's answers --------------------------------------------------------

/** A change waiting for the owner, read for their page. */
export type ChangeShown = {
  item: RepoItemRow
  repo: RepoView
  pending: Pending
  local: ItemDocument
  incoming: FetchedItem
  review: ItemReview
  resolved: ResolvedItem
}

/**
 * The waiting change, read again from the repository by its git id (so the
 * very change sync found), with its review against the vault's item.
 */
export async function pendingChange(
  ctx: VaultContext,
  itemId: string,
): Promise<ChangeShown> {
  const item = await getRepoItem(ctx, itemId)
  const pending = item.data.pending

  if (!pending) {
    throw new PcpError(
      "state",
      "Nothing from the repository waits for you on this item: it is in step, or you answered.",
    )
  }

  const repo = await getRepo(ctx, item.repoId)
  const gh = await clientFor(ctx, repo)
  const incoming = await fetchItemAt(
    gh,
    repo,
    pending.ref,
    item.data.path,
    pending.sha,
  )

  if (incoming.hash !== pending.hash) {
    throw new PcpError(
      "upstream",
      "What GitHub has at that change is not what sync found. Sync again.",
    )
  }

  const local = (await localOf(ctx, item)).document

  return {
    item,
    repo,
    pending,
    local,
    incoming,
    review: reviewItem(local, incoming.document),
    resolved: await resolveItem(ctx, incoming.document, { onto: true }),
  }
}

/** The change as the owner was shown it, checked to be so still. */
async function stillAsShown(
  ctx: VaultContext,
  itemId: string,
  shown: { sha: string; hash: string },
): Promise<ChangeShown> {
  const item = await getRepoItem(ctx, itemId)
  const pending = item.data.pending

  if (!pending || pending.sha !== shown.sha || pending.hash !== shown.hash) {
    throw new PcpError(
      "conflict",
      "The change is no longer the one you were shown: nothing was applied. Open it again.",
    )
  }

  const local = localHash((await localOf(ctx, item)).document)

  if (local !== pending.basis) {
    throw new PcpError(
      "conflict",
      "The item changed in your vault since you were shown this, so nothing was applied. Sync it again.",
    )
  }

  return pendingChange(ctx, itemId)
}

/** Take the repository's: applies exactly the change the owner was shown. */
export async function approveChange(
  ctx: VaultContext,
  itemId: string,
  shown: { sha: string; hash: string },
): Promise<string[]> {
  const change = await stillAsShown(ctx, itemId, shown)
  const applied = await applyItem(ctx, change.incoming.document, {
    id: change.item.itemId,
  })
  const after = await localOf(ctx, change.item)

  await saveItem(
    ctx,
    change.item,
    {
      ...cleared(change.item.data),
      remoteSha: change.pending.sha,
      localHash: localHash(after.document),
      declinedSha: null,
    },
    { state: "ok", lastSyncAt: new Date() },
  )

  return applied.notes
}

/** Not now: the change is left alone until the repository changes again. */
export async function declineChange(
  ctx: VaultContext,
  itemId: string,
  shown: { sha: string },
): Promise<void> {
  const item = await getRepoItem(ctx, itemId)

  if (item.data.pending?.sha !== shown.sha) {
    throw new PcpError(
      "conflict",
      "The change is no longer the one you were shown.",
    )
  }

  await saveItem(
    ctx,
    item,
    { ...cleared(item.data), declinedSha: shown.sha },
    { state: "ok" },
  )
}

/**
 * Keep mine, for a conflict: the vault's item stays. With two-way sync it
 * is pushed over the repository's, as a new commit on top of it; without,
 * the repository's change counts as seen.
 */
export async function keepMine(
  ctx: VaultContext,
  itemId: string,
  shown: { sha: string },
): Promise<SyncResult> {
  const item = await getRepoItem(ctx, itemId)

  if (item.data.pending?.sha !== shown.sha) {
    throw new PcpError(
      "conflict",
      "The change is no longer the one you were shown.",
    )
  }

  const repo = await getRepo(ctx, item.repoId)
  const local = await localOf(ctx, item)
  let remoteSha = shown.sha

  if (item.bidirectional && repo.access === "write") {
    const pushed = await pushDocument(
      await clientFor(ctx, repo),
      repo,
      local.document,
      { root: item.data.path, proposer: { by: "owner" } },
    )
    remoteSha = pushed.sha
  }

  await saveItem(
    ctx,
    item,
    {
      ...cleared(item.data),
      remoteSha,
      localHash: localHash(local.document),
      declinedSha: null,
    },
    { state: "ok", lastSyncAt: new Date() },
  )

  return {
    outcome: remoteSha === shown.sha ? "same" : "pushed",
    message:
      remoteSha === shown.sha
        ? "Yours stays; the repository's change is left there."
        : "Yours stays, and was pushed over the repository's.",
  }
}

/**
 * Writes an approved document to the vault's item and, with two-way sync,
 * to the repository: an assistant's merge, once the owner agreed
 * (assist.ts). `remoteSha` is the repository's side it was merged with.
 */
export async function applyMerged(
  ctx: VaultContext,
  item: RepoItemRow,
  document: ItemDocument,
  { remoteSha, proposer }: { remoteSha: string; proposer: Proposer },
): Promise<string[]> {
  const repo = await getRepo(ctx, item.repoId)
  const applied = await applyItem(ctx, document, { id: item.itemId })
  const after = await localOf(ctx, item)
  let sha = remoteSha
  const notes = [...applied.notes]

  if (item.bidirectional && repo.access === "write") {
    try {
      sha = (
        await pushDocument(await clientFor(ctx, repo), repo, after.document, {
          root: item.data.path,
          proposer,
        })
      ).sha
      notes.push("It was pushed to the repository.")
    } catch (error) {
      if (!isPcpError(error)) {
        throw error
      }

      notes.push(`It was not pushed: ${error.message}`)
    }
  }

  await saveItem(
    ctx,
    item,
    {
      ...cleared(item.data),
      remoteSha: sha,
      localHash: localHash(after.document),
      declinedSha: null,
    },
    { state: "ok", lastSyncAt: new Date() },
  )

  return notes
}

// ---- Adding and pushing items ---------------------------------------------------

export type AddChoice = {
  root: string
  hash: string
  /**
   * A new server or endpoint's first instance, as the owner gave it on the
   * page that adds it: its name, address, sign-in and note.
   */
  instance?: InstanceInput
}

export type AddResult = {
  root: string
  /** The vault's item it became: the skill's id, or the server row's. */
  id?: string
  ok: boolean
  message: string
  notes: string[]
}

/**
 * Adds items the owner chose on the repository's page, exactly as they were
 * shown: read again at the commit they were shown at (`commit`) and applied
 * only when the files hash as they did. Each becomes a linked item.
 */
export async function addFromRepo(
  ctx: VaultContext,
  repoId: string,
  { commit, items }: { commit: string; items: AddChoice[] },
): Promise<AddResult[]> {
  if (items.length === 0) {
    throw invalid("Choose at least one item to add.")
  }

  const repo = await getRepo(ctx, repoId)
  const gh = await clientFor(ctx, repo)
  const listing = await listRemote(
    gh,
    repo,
    repo.branch,
    await commitAt(gh, repo, commit),
  )
  const results: AddResult[] = []

  for (const choice of items) {
    const remote = listing.items.find((entry) => entry.root === choice.root)

    try {
      if (!remote) {
        throw invalid(`${choice.root} is not an item at that commit.`)
      }

      const fetched = await fetchItem(gh, repo, remote)

      if (fetched.hash !== choice.hash) {
        throw new PcpError(
          "conflict",
          "It is not what you were shown: nothing was added.",
        )
      }

      const found = await findLocalItem(ctx, fetched.item.ref)

      if (found && found.kind === null) {
        throw new PcpError(
          "conflict",
          `Something in your vault is called ${fetched.item.ref.name} already.`,
        )
      }

      const applied = await applyItem(ctx, fetched.document, {
        id: found?.id ?? null,
        instance: found ? undefined : choice.instance,
      })
      const kind = fetched.document.kind
      const after = await localItem(ctx, kind, applied.id)

      await linkItem(ctx, repoId, {
        kind,
        itemId: applied.id,
        path: remote.root,
        remoteSha: remote.sha,
        localHash: localHash(after.document),
        commit: listing.head.commit,
      })

      results.push({
        root: choice.root,
        id: applied.id,
        ok: true,
        message: found ? "Updated from the repository." : "Added.",
        notes: applied.notes,
      })
    } catch (error) {
      if (!isPcpError(error)) {
        throw error
      }

      results.push({
        root: choice.root,
        ok: false,
        message: error.message,
        notes: [],
      })
    }
  }

  return results
}

/** Whether an item ref is the one a pending change names. */
export function sameRef(a: ItemRef, b: ItemRef): boolean {
  return a.kind === b.kind && a.name === b.name
}
