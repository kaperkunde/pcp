import type { VaultContext } from "../context"

import {
  createRepo,
  githubSignInSecret,
  listRepos,
  type RepoView,
} from "./store"

/**
 * PCP's common items: kaperkunde/pcp-gg-common, a public repository pcp.gg
 * (Kaperkunde) keeps in PCP's own layout, with shared definitions anyone's
 * PCP can take (Docker services, to start). PCP offers it as one click
 * (the Repositories page, and Settings before anything is linked); the
 * owner chooses, nothing links it by itself.
 *
 * It is linked like any repository the owner does not push to: read-only
 * and not trusted, so every item added from it is pinned at the commit the
 * owner reviewed, and a change there waits for them as an update. It is
 * public, so PCP reads it without a sign-in; with PCP's GitHub sign-in in
 * the vault it reads it signed in, which GitHub allows more requests for.
 * It never holds a secret, and PCP never pushes to it.
 */

export const COMMON_REPOSITORY = {
  owner: "kaperkunde",
  name: "pcp-gg-common",
} as const

export function isCommonRepository(
  repo: Pick<RepoView, "owner" | "name">,
): boolean {
  return (
    repo.owner.toLowerCase() === COMMON_REPOSITORY.owner &&
    repo.name.toLowerCase() === COMMON_REPOSITORY.name
  )
}

/** The common repository as the vault links it, if it does. */
export async function commonRepository(
  ctx: VaultContext,
): Promise<RepoView | null> {
  return (await listRepos(ctx)).find(isCommonRepository) ?? null
}

/**
 * Links PCP's common items, read-only and untrusted, on its default branch;
 * the one it already has when it is linked.
 */
export async function addCommonRepository(
  ctx: VaultContext,
): Promise<{ id: string }> {
  const linked = await commonRepository(ctx)

  if (linked) {
    return { id: linked.id }
  }

  return createRepo(ctx, {
    ...COMMON_REPOSITORY,
    trust: "untrusted",
    access: "read",
    secretId: await githubSignInSecret(ctx),
  })
}
