import type { Repo, RepoItem } from "@/lib/generated/prisma/client"

import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString } from "../crypto"
import { db } from "../db"
import { invalid, notFound, PcpError } from "../errors"
import { newId } from "../ids"
import { listSkills } from "../skills"
import { githubCredential } from "../upstream"

import {
  branchHead,
  checkBranch,
  checkCoords,
  githubEndpoints,
  repoInfo,
  type GitHub,
  type RepoCoords,
} from "./github"
import type { ItemKind, ItemRef } from "./layout"
import {
  GITHUB_SIGNIN_SECRET,
  MAX_REPOS,
  SYNC_FREQUENCIES,
  type SyncFrequency,
} from "./limits"

/**
 * The repositories the owner linked and the items linked to them, as rows:
 * `repo` and `repo_item`. Which repository, where an item is in it, the
 * hashes sync compares and a change waiting for the owner are one
 * ciphertext each under the vault's key ("repo:<id>", "repo_item:<id>");
 * how often it syncs and its state are plain, since sync reads them to find
 * what is due.
 */

export type RepoTrust = "trusted" | "untrusted"
export type RepoAccess = "read" | "write"

export type RepoState = RepoCoords & { branch: string }

/** How PCP signs in to GitHub for a repository. */
export type RepoSignIn = "none" | "token" | "github"

export type RepoView = RepoState & {
  id: string
  trust: RepoTrust
  access: RepoAccess
  signIn: RepoSignIn
  secretId: string | null
  /** The secret's name, for a token. */
  secretName: string | null
  createdAt: Date
}

/** A change waiting for the owner, named by its object in the repository. */
export type Pending = {
  kind: "review" | "conflict"
  /** The item as the repository has it. */
  ref: ItemRef
  /** The item's tree (or a server's file) in the repository: its git id. */
  sha: string
  /** filesHash of the files read at that id, as the owner is shown them. */
  hash: string
  /** The commit it was read at. */
  commit: string
  /** localHash of the vault's item when it was found; null: none. */
  basis: string | null
  /** How many things it would let reach further (review.ts flags). */
  flags: number
  foundAt: string
}

export type RepoItemData = {
  /** The item's folder (or a server's file) from the repository's root. */
  path: string
  /** The git id of that folder or file when sync last agreed with it. */
  remoteSha: string | null
  /** localHash of the vault's item when sync last agreed with it. */
  localHash: string | null
  pending: Pending | null
  /** A change the owner said no to: sync leaves it alone. */
  declinedSha: string | null
  /** Files an assistant wrote toward a proposal, by token, by file name. */
  drafts: Record<string, Record<string, string>>
  /** What the last sync said, when it is worth a line. */
  note: string | null
}

export type RepoItemState =
  "ok" | "review" | "conflict" | "local" | "missing" | "error"

export type RepoItemRow = Omit<RepoItem, "ciphertext"> & {
  data: RepoItemData
  kind: ItemKind
  /** The skill's or server row's id. */
  itemId: string
}

function repoAad(id: string): string {
  return `repo:${id}`
}

function itemAad(id: string): string {
  return `repo_item:${id}`
}

export function readRepoState(ctx: VaultContext, row: Repo): RepoState {
  return JSON.parse(
    decryptString(ctx.dek, Buffer.from(row.ciphertext), repoAad(row.id)),
  ) as RepoState
}

async function viewOf(ctx: VaultContext, row: Repo): Promise<RepoView> {
  const secret = row.secretId
    ? await db().secret.findFirst({
        where: { id: row.secretId, vaultId: ctx.vaultId },
        select: { name: true, kind: true },
      })
    : null

  return {
    ...readRepoState(ctx, row),
    id: row.id,
    trust: row.trust === "trusted" ? "trusted" : "untrusted",
    access: row.access === "write" ? "write" : "read",
    signIn: !secret ? "none" : secret.kind === "oauth" ? "github" : "token",
    secretId: secret ? row.secretId : null,
    secretName: secret && secret.kind === "text" ? secret.name : null,
    createdAt: row.createdAt,
  }
}

export async function listRepos(ctx: VaultContext): Promise<RepoView[]> {
  const rows = await db().repo.findMany({
    where: { vaultId: ctx.vaultId },
    orderBy: { createdAt: "asc" },
  })

  return Promise.all(rows.map((row) => viewOf(ctx, row)))
}

async function repoRow(ctx: VaultContext, id: string): Promise<Repo> {
  const row = await db().repo.findFirst({ where: { id, vaultId: ctx.vaultId } })

  if (!row) {
    throw notFound("That repository")
  }

  return row
}

export async function getRepo(
  ctx: VaultContext,
  id: string,
): Promise<RepoView> {
  return viewOf(ctx, await repoRow(ctx, id))
}

/** A client for the repository, signed in with its secret, if it has one. */
export async function clientFor(
  ctx: VaultContext,
  repo: Pick<RepoView, "secretId">,
): Promise<GitHub> {
  return {
    endpoints: githubEndpoints(),
    credential: await githubCredential(ctx, repo.secretId),
  }
}

/** A secret the owner may sign a repository in with: a text one, or PCP's GitHub sign-in. */
async function checkSecret(
  ctx: VaultContext,
  secretId: string | null,
): Promise<string | null> {
  if (!secretId) {
    return null
  }

  const secret = await db().secret.findFirst({
    where: { id: secretId, vaultId: ctx.vaultId },
    select: { kind: true, name: true },
  })

  if (
    !secret ||
    !(
      secret.kind === "text" ||
      (secret.kind === "oauth" && secret.name === GITHUB_SIGNIN_SECRET)
    )
  ) {
    throw invalid(
      "Choose one of your secrets (a GitHub token), or sign in to GitHub.",
    )
  }

  return secretId
}

/** The id of PCP's GitHub sign-in in this vault, when the owner signed in. */
export async function githubSignInSecret(
  ctx: VaultContext,
): Promise<string | null> {
  const row = await db().secret.findUnique({
    where: {
      vaultId_name: { vaultId: ctx.vaultId, name: GITHUB_SIGNIN_SECRET },
    },
    select: { id: true, kind: true },
  })

  return row && row.kind === "oauth" ? row.id : null
}

export type RepoInput = {
  owner: string
  name: string
  /** Empty: the repository's default branch. */
  branch?: string
  trust: RepoTrust
  access: RepoAccess
  secretId: string | null
}

/**
 * What GitHub says of the repository with this sign-in: that it can be
 * read, its branch, and for read-write that the sign-in may push.
 */
async function checkWithGitHub(
  gh: GitHub,
  coords: RepoCoords,
  branch: string | undefined,
  access: RepoAccess,
): Promise<string> {
  const info = await repoInfo(gh, coords)
  const chosen = branch?.trim() ? checkBranch(branch) : info.defaultBranch

  // The branch has to be there: sync reads it, and a push moves it.
  await branchHead(gh, coords, chosen)

  if (access === "write" && info.push !== true) {
    throw new PcpError(
      "forbidden",
      info.push === null
        ? "Read and write needs a sign-in GitHub says may push to the repository: choose a token, or sign in to GitHub."
        : `GitHub says this sign-in may not push to ${coords.owner}/${coords.name}, so it can only be read-only.`,
    )
  }

  return chosen
}

export async function createRepo(
  ctx: VaultContext,
  input: RepoInput,
): Promise<{ id: string }> {
  const coords = checkCoords(input.owner, input.name)
  const secretId = await checkSecret(ctx, input.secretId)
  const existing = await listRepos(ctx)

  if (existing.length >= MAX_REPOS) {
    throw invalid(`A vault links at most ${MAX_REPOS} repositories.`)
  }

  const gh = await clientFor(ctx, { secretId })
  const branch = await checkWithGitHub(gh, coords, input.branch, input.access)

  if (
    existing.some(
      (repo) =>
        repo.owner.toLowerCase() === coords.owner.toLowerCase() &&
        repo.name.toLowerCase() === coords.name.toLowerCase() &&
        repo.branch === branch,
    )
  ) {
    throw new PcpError(
      "conflict",
      `${coords.owner}/${coords.name} (${branch}) is linked already.`,
    )
  }

  const id = newId()
  const state: RepoState = { ...coords, branch }

  await db().repo.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      ciphertext: asBytes(
        encryptString(ctx.dek, JSON.stringify(state), repoAad(id)),
      ),
      trust: input.trust,
      access: input.access,
      secretId,
    },
  })

  return { id }
}

/** The owner's change to a repository's trust, access or sign-in. */
export async function updateRepo(
  ctx: VaultContext,
  id: string,
  input: Pick<RepoInput, "trust" | "access" | "secretId">,
): Promise<void> {
  const row = await repoRow(ctx, id)
  const state = readRepoState(ctx, row)
  const secretId = await checkSecret(ctx, input.secretId)

  // A new sign-in, or read and write, is checked with GitHub again.
  if (input.access === "write" || secretId !== row.secretId) {
    await checkWithGitHub(
      await clientFor(ctx, { secretId }),
      state,
      state.branch,
      input.access,
    )
  }

  await db().repo.update({
    where: { id },
    data: { trust: input.trust, access: input.access, secretId },
  })

  // Pushing needs read and write.
  if (input.access === "read") {
    await db().repoItem.updateMany({
      where: { repoId: id },
      data: { bidirectional: false },
    })
  }
}

/** Unlinks the repository: its items stay in the vault, unlinked. */
export async function deleteRepo(ctx: VaultContext, id: string): Promise<void> {
  await repoRow(ctx, id)
  await db().repo.delete({ where: { id } })
}

// ---- Items --------------------------------------------------------------------

function itemOf(ctx: VaultContext, row: RepoItem): RepoItemRow {
  const { ciphertext, ...rest } = row
  const data = JSON.parse(
    decryptString(ctx.dek, Buffer.from(ciphertext), itemAad(row.id)),
  ) as RepoItemData

  return {
    ...rest,
    data: { ...data, drafts: data.drafts ?? {} },
    kind: row.itemKind as ItemKind,
    itemId: (row.skillId ?? row.serverId)!,
  }
}

export function encryptItemData(
  ctx: VaultContext,
  id: string,
  data: RepoItemData,
): Uint8Array<ArrayBuffer> {
  return asBytes(encryptString(ctx.dek, JSON.stringify(data), itemAad(id)))
}

/** The items linked to a repository, or to any of the vault's. */
export async function listRepoItems(
  ctx: VaultContext,
  repoId?: string,
): Promise<RepoItemRow[]> {
  const rows = await db().repoItem.findMany({
    where: { repo: { vaultId: ctx.vaultId }, ...(repoId ? { repoId } : {}) },
    orderBy: { createdAt: "asc" },
  })

  return rows.map((row) => itemOf(ctx, row))
}

export async function getRepoItem(
  ctx: VaultContext,
  id: string,
): Promise<RepoItemRow> {
  const row = await db().repoItem.findFirst({
    where: { id, repo: { vaultId: ctx.vaultId } },
  })

  if (!row) {
    throw notFound("That linked item")
  }

  return itemOf(ctx, row)
}

/** The link of a vault item, by its kind and id, if it has one. */
export async function findRepoItem(
  ctx: VaultContext,
  kind: ItemKind,
  itemId: string,
): Promise<RepoItemRow | null> {
  const row = await db().repoItem.findFirst({
    where: {
      repo: { vaultId: ctx.vaultId },
      ...(kind === "skill" ? { skillId: itemId } : { serverId: itemId }),
    },
  })

  return row ? itemOf(ctx, row) : null
}

/** Links a vault item to its place in a repository, or moves its link there. */
export async function linkItem(
  ctx: VaultContext,
  repoId: string,
  input: {
    kind: ItemKind
    itemId: string
    path: string
    remoteSha: string
    localHash: string
    frequency?: SyncFrequency
    bidirectional?: boolean
  },
): Promise<{ id: string }> {
  const repo = await getRepo(ctx, repoId)
  const existing = await findRepoItem(ctx, input.kind, input.itemId)
  const data: RepoItemData = {
    path: input.path,
    remoteSha: input.remoteSha,
    localHash: input.localHash,
    pending: null,
    declinedSha: null,
    drafts: {},
    note: null,
  }
  const sync = {
    frequency: input.frequency ?? existing?.frequency ?? "daily",
    bidirectional:
      repo.access === "write" &&
      (input.bidirectional ?? existing?.bidirectional ?? false),
  }

  if (existing) {
    await db().repoItem.update({
      where: { id: existing.id },
      data: {
        repoId,
        itemKind: input.kind,
        ciphertext: encryptItemData(ctx, existing.id, data),
        ...sync,
        state: "ok",
        lastSyncAt: new Date(),
      },
    })

    return { id: existing.id }
  }

  const id = newId()

  await db().repoItem.create({
    data: {
      id,
      repoId,
      itemKind: input.kind,
      ...(input.kind === "skill"
        ? { skillId: input.itemId }
        : { serverId: input.itemId }),
      ciphertext: encryptItemData(ctx, id, data),
      ...sync,
      state: "ok",
      lastSyncAt: new Date(),
    },
  })

  return { id }
}

/** Writes an item's data and state, as sync or the owner's answer left them. */
export async function saveItem(
  ctx: VaultContext,
  item: Pick<RepoItemRow, "id">,
  data: RepoItemData,
  fields: { state?: RepoItemState; lastSyncAt?: Date } = {},
): Promise<void> {
  await db().repoItem.update({
    where: { id: item.id },
    data: { ciphertext: encryptItemData(ctx, item.id, data), ...fields },
  })
}

/** The owner's choice of how an item syncs. */
export async function setItemSync(
  ctx: VaultContext,
  id: string,
  input: { frequency: string; bidirectional: boolean },
): Promise<void> {
  const item = await getRepoItem(ctx, id)
  const repo = await getRepo(ctx, item.repoId)

  if (!(SYNC_FREQUENCIES as readonly string[]).includes(input.frequency)) {
    throw invalid("Sync is off, hourly, daily or weekly.")
  }

  if (input.bidirectional && repo.access !== "write") {
    throw invalid(
      "Two-way sync pushes your changes, so it needs a read-and-write repository.",
    )
  }

  await db().repoItem.update({
    where: { id },
    data: {
      frequency: input.frequency,
      bidirectional: input.bidirectional,
    },
  })
}

/** What the owner calls each linked item: a skill's name, a server's. */
export async function linkedItemNames(
  ctx: VaultContext,
  items: RepoItemRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()

  if (items.some((item) => item.kind === "skill")) {
    for (const skill of await listSkills(ctx)) {
      names.set(skill.id, skill.name)
    }
  }

  const servers = await db().mcpServer.findMany({
    where: {
      vaultId: ctx.vaultId,
      id: {
        in: items
          .filter((item) => item.kind !== "skill")
          .map((item) => item.itemId),
      },
    },
    select: { id: true, name: true },
  })

  for (const server of servers) {
    names.set(server.id, server.name)
  }

  return names
}

/** Unlinks an item: it stays in the vault as it is. */
export async function unlinkItem(ctx: VaultContext, id: string): Promise<void> {
  await getRepoItem(ctx, id)
  await db().repoItem.delete({ where: { id } })
}
