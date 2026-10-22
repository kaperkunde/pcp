"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { invalid } from "@/lib/core/errors"
import type { ItemKind } from "@/lib/core/repos/layout"
import { pollGitHubSignIn, startGitHubSignIn } from "@/lib/core/repos/signin"
import {
  createRepo,
  deleteRepo,
  githubSignInSecret,
  setItemSync,
  unlinkItem,
  updateRepo,
  type RepoAccess,
  type RepoTrust,
} from "@/lib/core/repos/store"
import {
  addFromRepo,
  approveChange,
  declineChange,
  keepMine,
  pushItems,
  syncItem,
  syncRepo,
  type AddChoice,
} from "@/lib/core/repos/sync"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * Settings → Repositories (lib/core/repos/): the owner links GitHub
 * repositories, adds items from them, pushes their own, and answers what
 * sync left for them. Every action reads the owner's session.
 */

export type RepoActionResult = ActionState<{
  id?: string
  message?: string
  lines?: string[]
}>

const PAGES = "/settings/repositories"

function revalidate(): void {
  revalidatePath(PAGES, "layout")
}

function trustOf(formData: FormData): RepoTrust {
  return field(formData, "trust") === "trusted" ? "trusted" : "untrusted"
}

function accessOf(formData: FormData): RepoAccess {
  return field(formData, "access") === "write" ? "write" : "read"
}

/** The sign-in a form chose: none, one of the owner's secrets, or GitHub's. */
async function secretOf(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  formData: FormData,
): Promise<string | null> {
  switch (field(formData, "signIn")) {
    case "token": {
      const id = field(formData, "secretId")

      if (!id) {
        throw invalid("Choose the secret that holds your GitHub token.")
      }

      return id
    }
    case "github": {
      const id = await githubSignInSecret(ctx)

      if (!id) {
        throw invalid("Sign in to GitHub first.")
      }

      return id
    }
    default:
      return null
  }
}

export async function createRepoAction(
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const [owner = "", name = ""] = field(formData, "repo").trim().split("/")

    return createRepo(ctx, {
      owner,
      name,
      branch: field(formData, "branch"),
      trust: trustOf(formData),
      access: accessOf(formData),
      secretId: await secretOf(ctx, formData),
    })
  })

  revalidate()

  return result
}

export async function updateRepoAction(
  id: string,
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await updateRepo(ctx, id, {
      trust: trustOf(formData),
      access: accessOf(formData),
      secretId: await secretOf(ctx, formData),
    })

    return { message: "Saved." }
  })

  revalidate()

  return result
}

export async function deleteRepoAction(id: string): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await deleteRepo(ctx, id)
    return {}
  })

  revalidate()

  if (result.status === "ok") {
    redirect(PAGES)
  }

  return result
}

export async function syncRepoAction(id: string): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const results = await syncRepo(ctx, id)

    return {
      message:
        results.length === 0
          ? "No item is linked to it yet."
          : `Synced ${results.length} item${results.length === 1 ? "" : "s"}.`,
      lines: results.map((entry) => entry.message),
    }
  })

  revalidate()

  return result
}

export async function syncItemAction(id: string): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => ({
    message: (await syncItem(ctx, id)).message,
  }))

  revalidate()

  return result
}

export async function setItemSyncAction(
  id: string,
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await setItemSync(ctx, id, {
      frequency: field(formData, "frequency"),
      bidirectional: field(formData, "bidirectional") === "on",
    })

    return { message: "Saved." }
  })

  revalidate()

  return result
}

export async function unlinkItemAction(id: string): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await unlinkItem(ctx, id)
    return { message: "Unlinked: it stays in your vault." }
  })

  revalidate()

  return result
}

/** Adds the items the owner was shown at that commit, as they were shown. */
export async function addItemsAction(
  repoId: string,
  commit: string,
  items: AddChoice[],
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const results = await addFromRepo(ctx, repoId, {
      commit,
      items: items.map((item) => ({
        root: String(item.root),
        hash: String(item.hash),
      })),
    })
    const added = results.filter((entry) => entry.ok).length

    return {
      message: `Added ${added} of ${results.length}.`,
      lines: results.flatMap((entry) => [
        `${entry.root}: ${entry.message}`,
        ...entry.notes,
      ]),
    }
  })

  revalidate()
  revalidatePath("/skills")
  revalidatePath("/servers")

  return result
}

export async function pushItemsAction(
  repoId: string,
  items: Array<{ kind: string; id: string }>,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const results = await pushItems(
      ctx,
      repoId,
      items.map((item) => ({
        kind: item.kind as ItemKind,
        id: String(item.id),
      })),
    )

    return {
      message: `Pushed ${results.filter((entry) => entry.ok).length} of ${results.length}.`,
      lines: results.map((entry) => `${entry.name}: ${entry.message}`),
    }
  })

  revalidate()

  return result
}

/** The owner's answer to a change sync left for them. */
export async function answerChangeAction(
  itemId: string,
  answer: "approve" | "decline" | "keep",
  shown: { sha: string; hash: string },
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const sha = String(shown.sha)

    switch (answer) {
      case "approve": {
        const notes = await approveChange(ctx, itemId, {
          sha,
          hash: String(shown.hash),
        })
        return { message: "Applied as you were shown it.", lines: notes }
      }
      case "keep":
        return { message: (await keepMine(ctx, itemId, { sha })).message }
      default:
        await declineChange(ctx, itemId, { sha })
        return {
          message: "Left alone: sync asks again when the repository changes.",
        }
    }
  })

  revalidate()
  revalidatePath("/home")

  return result
}

export type SignInResult = ActionState<{
  state: "waiting" | "done" | "expired" | "denied" | "none"
  userCode?: string
  verificationUri?: string
}>

/** Starts PCP's GitHub sign-in: a code for github.com/login/device. */
export async function startGitHubSignInAction(
  scope: string,
): Promise<SignInResult> {
  const ctx = await requireContext()

  return guarded(async () => {
    const code = await startGitHubSignIn(ctx, {
      scope: scope === "repo" ? "repo" : "public_repo",
    })
    return {
      state: "waiting" as const,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
    }
  })
}

/** Asks whether the owner approved the code; the page calls it while open. */
export async function pollGitHubSignInAction(): Promise<SignInResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const state = await pollGitHubSignIn(ctx)

    return state.status === "waiting"
      ? {
          state: "waiting" as const,
          userCode: state.code.userCode,
          verificationUri: state.code.verificationUri,
        }
      : { state: state.status }
  })

  if (result.status === "ok" && result.state === "done") {
    revalidate()
  }

  return result
}
