import Link from "next/link"
import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { AddItemsButton } from "@/components/repo-forms"
import { RepoFilesReview } from "@/components/repo-review"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { isPcpError } from "@/lib/core/errors"
import { resolveItem, type ResolvedItem } from "@/lib/core/repos/apply"
import type { ItemDocument } from "@/lib/core/repos/documents"
import { commitAt } from "@/lib/core/repos/github"
import { findLocalItem, localItem } from "@/lib/core/repos/local"
import {
  fetchItem,
  listRemote,
  type FetchedItem,
} from "@/lib/core/repos/remote"
import { reviewItem, type ItemReview } from "@/lib/core/repos/review"
import { clientFor, getRepo } from "@/lib/core/repos/store"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add from a repository" }

export const dynamic = "force-dynamic"

type Shown = {
  root: string
  fetched: FetchedItem | null
  review: ItemReview | null
  resolved: ResolvedItem | null
  problem: string | null
}

function listOf(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/**
 * The items the owner chose, each in full as it would be added (against
 * the vault's item of that name, or nothing), read at the commit they chose
 * them at. The confirm adds exactly these: lib/core/repos/sync.ts
 * addFromRepo reads them again at that commit and checks they hash the same.
 */
export default async function AddPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const query = await searchParams
  const commit = typeof query.commit === "string" ? query.commit : ""
  const back = {
    href: `/settings/repositories/${id}/browse`,
    label: "Choose again",
  }
  let shown: Shown[] = []
  let failure: string | null = null
  let label = "the repository"

  try {
    const repo = await getRepo(ctx, id)
    label = `${repo.owner}/${repo.name}`
    const gh = await clientFor(ctx, repo)
    const listing = await listRemote(
      gh,
      repo,
      repo.branch,
      await commitAt(gh, repo, commit),
    )
    const chosen =
      query.all === "1"
        ? listing.items.map((item) => item.root)
        : listOf(query.item)

    shown = await Promise.all(
      chosen.slice(0, 100).map(async (root): Promise<Shown> => {
        const remote = listing.items.find((item) => item.root === root)

        if (!remote) {
          return {
            root,
            fetched: null,
            review: null,
            resolved: null,
            problem: "Not an item at that commit.",
          }
        }

        try {
          const fetched = await fetchItem(gh, repo, remote)
          const found = await findLocalItem(ctx, remote.ref)
          let current: ItemDocument | null = null

          if (found?.kind) {
            current = (await localItem(ctx, found.kind, found.id)).document
          } else if (found) {
            throw new Error(
              `Something in your vault is called ${remote.ref.name} already.`,
            )
          }

          const resolved = await resolveItem(ctx, fetched.document)

          return {
            root,
            fetched,
            review: reviewItem(current, fetched.document),
            resolved,
            problem:
              resolved.problems.length > 0 ? resolved.problems.join(" ") : null,
          }
        } catch (error) {
          return {
            root,
            fetched: null,
            review: null,
            resolved: null,
            problem: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
  } catch (error) {
    if (!isPcpError(error)) {
      throw error
    }

    failure = error.message
  }

  const ready = shown.filter((entry) => entry.fetched && !entry.problem)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={back}
        title={`Add from ${label}`}
        description="Read each item whole before you add it: its files as they would be, and what in them reaches further than text."
      />

      {failure ? (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      ) : null}

      {shown.map((entry) => (
        <Card
          key={entry.root}
          className="flex flex-col gap-4 p-5"
          data-testid="repo-add-item"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-semibold break-all">
              {entry.root}
            </h2>
            {entry.review ? (
              <Badge variant="secondary">
                {entry.review.isNew
                  ? "New"
                  : entry.review.same
                    ? "Same as yours"
                    : "Updates yours"}
              </Badge>
            ) : null}
          </div>
          {entry.problem ? (
            <p className="text-sm text-destructive" role="alert">
              {entry.problem} It is left out.
            </p>
          ) : null}
          {entry.resolved && entry.resolved.missingSecrets.length > 0 ? (
            <p className="text-sm text-warning" role="note">
              It names secrets your vault does not have:{" "}
              {entry.resolved.missingSecrets
                .map((name) => `"${name}"`)
                .join(", ")}
              . It is added without them; add them under{" "}
              <Link href="/secrets" className="underline">
                Secrets
              </Link>{" "}
              and give them to it on its page.
            </p>
          ) : null}
          {entry.fetched && entry.review ? (
            <RepoFilesReview
              flags={entry.review.flags}
              files={entry.review.files}
              whole={Object.entries(entry.fetched.files)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([path, text]) => ({ path, text }))}
              caption={
                entry.review.isNew ? "Its files" : "What changes in your vault"
              }
            />
          ) : null}
        </Card>
      ))}

      {ready.length > 0 ? (
        <div className="flex flex-col items-end gap-2">
          <AddItemsButton
            repoId={id}
            commit={commit}
            items={ready.map((entry) => ({
              root: entry.root,
              hash: entry.fetched!.hash,
            }))}
          />
          <p className="text-xs text-muted-foreground">
            Each is added exactly as shown, and linked to sync daily from the
            repository; you change that on the repository&apos;s page.
          </p>
        </div>
      ) : shown.length === 0 && !failure ? (
        <p className="text-sm text-muted-foreground">Nothing was chosen.</p>
      ) : null}
    </PageColumn>
  )
}
