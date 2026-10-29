"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { invalid } from "@/lib/core/errors"
import { nextPendingRequest } from "@/lib/core/owner-queue"
import { confirmProposedShare } from "@/lib/core/permissions"
import { addCommonRepository } from "@/lib/core/repos/common"
import { ITEM_DIRS, type ItemKind } from "@/lib/core/repos/layout"
import {
  confirmShare,
  keepAddressPrivate,
  moveToNote,
  renameShared,
  REVIEW_CHANGED,
  setSharedDescription,
} from "@/lib/core/repos/share-review"
import { pollGitHubSignIn, startGitHubSignIn } from "@/lib/core/repos/signin"
import {
  createRepo,
  deleteRepo,
  githubSignInSecret,
  setExcluded,
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
  syncItem,
  syncRepo,
  type AddChoice,
} from "@/lib/core/repos/sync"
import { getServer } from "@/lib/core/servers"
import { launchService, syncServerTools } from "@/lib/core/upstream"
import {
  type ActionState,
  field,
  fields,
  guarded,
} from "@/lib/server/action-state"
import { instanceInputFrom } from "@/lib/server/instance-input"
import { publicUrlFor } from "@/lib/server/public-url"
import { serviceInputFrom, withNewSecrets } from "@/lib/server/service-input"
import { requireContext } from "@/lib/server/session"

const ITEM_KINDS = Object.keys(ITEM_DIRS)

/**
 * Settings → Repositories (lib/core/repos/): the owner links GitHub
 * repositories, adds items from them, pushes their own, and answers what
 * sync left for them. Every action reads the owner's session.
 */

export type RepoActionResult = ActionState<{
  id?: string
  message?: string
  lines?: string[]
  /**
   * After the owner answered a change: the oldest thing still waiting for
   * them (lib/core/owner-queue.ts), or null when nothing is.
   */
  next?: string | null
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

/**
 * PCP's common items (lib/core/repos/common.ts): linked read-only and
 * untrusted, then the owner browses what it offers.
 */
export async function addCommonRepoAction(): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(() => addCommonRepository(ctx))

  revalidate()

  if (result.status === "ok") {
    redirect(`${PAGES}/${encodeURIComponent(result.id!)}/browse`)
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

/** "kind:id", as the review's pages name an item. */
function itemOf(value: string): { kind: ItemKind; id: string } {
  const at = value.indexOf(":")
  const kind = value.slice(0, at)

  if (at < 1 || !(ITEM_KINDS as readonly string[]).includes(kind)) {
    throw invalid("That is not an item PCP shares.")
  }

  return { kind: kind as ItemKind, id: value.slice(at + 1) }
}

/** The review of the first item, with the ones after it waiting their turn. */
function shareHref(
  repoId: string,
  items: string[],
  extra: Record<string, string> = {},
): string {
  const query = new URLSearchParams()

  for (const item of items) {
    query.append("item", item)
  }

  for (const [key, value] of Object.entries(extra)) {
    query.set(key, value)
  }

  return `${PAGES}/${encodeURIComponent(repoId)}/share?${query}`
}

/**
 * Confirm on the review page: pushes the item exactly as it was shown, then
 * opens the next item's review, or the repository's page. When anything
 * changed since the page opened, nothing is pushed and the review opens
 * again.
 */
export async function confirmShareAction(
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const repoId = field(formData, "repoId")
  const items = fields(formData, "item")
  // An assistant's proposal: pushed as the review shows it, naming the
  // token, and the request is answered.
  const request = field(formData, "request")
  const result = await guarded(async () => {
    const options = {
      basis: field(formData, "basis"),
      acknowledged: fields(formData, "acknowledged"),
      publicUrl: await publicUrlFor(ctx),
    }
    const item = itemOf(items[0] ?? "")

    return request
      ? confirmProposedShare(ctx, request, { repoId, item, ...options })
      : confirmShare(ctx, repoId, item, options)
  })

  revalidate()

  if (result.status === "error" && result.error === REVIEW_CHANGED) {
    redirect(
      shareHref(repoId, items, {
        changed: "1",
        ...(request ? { request } : {}),
      }),
    )
  }

  if (result.status !== "ok") {
    return result
  }

  if (request) {
    revalidatePath("/", "layout")
    redirect(`/permissions/${encodeURIComponent(request)}`)
  }

  const rest = items.slice(1)
  redirect(
    rest.length > 0
      ? shareHref(repoId, rest, { pushed: result.root })
      : `${PAGES}/${encodeURIComponent(repoId)}?pushed=${encodeURIComponent(result.root)}`,
  )
}

/**
 * A fix the review page offers for something that looks personal: the
 * description edited, a sentence of it moved to the owner's note, what is
 * shared renamed, or an endpoint's address left out of its shared schema.
 * The review opens again with the change in it.
 */
export async function shareFixAction(
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const repoId = field(formData, "repoId")
  const items = fields(formData, "item")
  const result = await guarded(async () => {
    const item = itemOf(items[0] ?? "")

    switch (field(formData, "fix")) {
      case "edit_description":
        await setSharedDescription(ctx, item, field(formData, "description"))
        break
      case "move_to_note":
        await moveToNote(ctx, item, field(formData, "match"))
        break
      case "rename":
        await renameShared(ctx, item.id, {
          name: field(formData, "name"),
          slug: field(formData, "slug"),
        })
        break
      case "instance_address":
        await keepAddressPrivate(ctx, item.id)
        break
      default:
        throw invalid("That is not a fix PCP offers.")
    }

    return {}
  })

  if (result.status !== "ok") {
    return result
  }

  const request = field(formData, "request")

  revalidatePath("/", "layout")
  redirect(
    shareHref(repoId, items, { fixed: "1", ...(request ? { request } : {}) }),
  )
}

/** Keeps an item out of a repository on purpose, or takes it back in. */
export async function setExcludedAction(
  repoId: string,
  item: string,
  excluded: boolean,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await setExcluded(ctx, repoId, itemOf(String(item)), excluded === true)
    return {
      message: excluded
        ? "Kept out of this repository."
        : "Included again: it is under Not pushed.",
    }
  })

  revalidate()

  return result
}

/**
 * Adds a new MCP server or API endpoint from a repository, as the owner was
 * shown it at that commit, with its first instance as they gave it: its
 * name, address, sign-in, switches and note. Opens its page.
 */
export async function importItemAction(
  repoId: string,
  choice: { commit: string; root: string; hash: string },
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const [added] = await addFromRepo(ctx, repoId, {
      commit: String(choice.commit),
      items: [
        {
          root: String(choice.root),
          hash: String(choice.hash),
          instance: {
            ...instanceInputFrom(formData),
            // Only where the form showed them (an endpoint's); otherwise
            // what the item says, or the safe default.
            ...(field(formData, "switches") === "1"
              ? {
                  readOnly: field(formData, "readOnly") === "on",
                  publicOnly: field(formData, "publicOnly") === "on",
                }
              : {}),
          },
        },
      ],
    })

    if (!added?.ok || !added.id) {
      throw invalid(added?.message ?? "Nothing was added.")
    }

    // An MCP server's tools come from it: read them now, as adding one does.
    const server = await getServer(ctx, added.id)

    if (server.kind === "mcp") {
      await syncServerTools(ctx, server, { publicUrl: await publicUrlFor(ctx) })
    }

    return { id: added.id }
  })

  if (result.status !== "ok") {
    return result
  }

  revalidate()
  revalidatePath("/servers", "layout")
  redirect(`/servers/${encodeURIComponent(result.id!)}`)
}

/**
 * A new service from a repository, launched with the owner's own part:
 * the item read again at the commit shown, and launched only when it hashes
 * as it did; then linked to the repository.
 */
export async function importServiceAction(
  repoId: string,
  choice: { commit: string; root: string; hash: string },
  _previous: RepoActionResult,
  formData: FormData,
): Promise<RepoActionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)
  const result = await guarded(async () => {
    const input = serviceInputFrom(formData)
    // A launch that fails deletes the secrets typed in for it again.
    const added = await withNewSecrets(
      ctx,
      formData,
      input.env,
      async (env) => {
        const [one] = await addFromRepo(ctx, repoId, {
          commit: String(choice.commit),
          items: [
            {
              root: String(choice.root),
              hash: String(choice.hash),
              service: {
                input: { ...input, env },
                launch: (launchCtx, launchInput) =>
                  launchService(launchCtx, launchInput, { publicUrl }),
              },
            },
          ],
        })

        if (!one?.ok || !one.id) {
          throw invalid(one?.message ?? "Nothing was launched.")
        }

        return one
      },
    )

    return { id: added.id! }
  })

  if (result.status !== "ok") {
    return result
  }

  revalidate()
  revalidatePath("/servers", "layout")
  redirect(`/servers/${encodeURIComponent(result.id!)}`)
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
    const answered = await (async () => {
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
    })()

    return { ...answered, next: await nextPendingRequest(ctx, itemId) }
  })

  // The bell and Home's count are on every page.
  revalidatePath("/", "layout")

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
