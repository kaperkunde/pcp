import { TriangleAlert } from "lucide-react"
import Link from "next/link"
import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { ChangeAnswer } from "@/components/repo-forms"
import { RepoFilesReview } from "@/components/repo-review"
import { Card } from "@/components/ui/card"
import { isPcpError } from "@/lib/core/errors"
import { REPO_REF } from "@/lib/core/repos/assist"
import { pendingChange, type ChangeShown } from "@/lib/core/repos/sync"
import { getRepoItem } from "@/lib/core/repos/store"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = {
  title: "Change from a repository",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

/**
 * What sync left for the owner on one linked item: a change to review (from
 * a repository they do not trust, or one that reaches further than text) or
 * a conflict. Every file and flag in full, read again from the repository by
 * the change's git id, then the answers. The bell links here.
 */
export default async function ChangePage({
  params,
}: {
  params: Promise<{ itemId: string }>
}) {
  const ctx = await requireContext()
  const { itemId } = await params
  let change: ChangeShown | null = null
  let failure: string | null = null
  let repoId: string | null = null

  try {
    repoId = (await getRepoItem(ctx, itemId)).repoId
    change = await pendingChange(ctx, itemId)
  } catch (error) {
    if (!isPcpError(error)) {
      throw error
    }

    failure = error.message
  }

  const back = repoId
    ? { href: `/settings/repositories/${repoId}`, label: "Repository" }
    : { href: "/settings/repositories", label: "Repositories" }

  if (!change) {
    return (
      <PageColumn width="narrow">
        <PageHeader back={back} title="Change from a repository" />
        <p className="text-muted-foreground" role="alert">
          {failure ?? "Nothing waits for you here."}
        </p>
      </PageColumn>
    )
  }

  const { repo, pending, review, resolved, incoming, item } = change
  const conflict = pending.kind === "conflict"

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={back}
        title={
          conflict
            ? `Conflict in ${item.data.path}`
            : `Change to ${item.data.path}`
        }
        description={`From ${repo.owner}/${repo.name} (${repo.branch}), ${repo.trust === "trusted" ? "a repository you trust" : "a repository you do not trust"}.`}
      />

      <Card className="flex flex-col gap-5 p-5 ring-1 ring-warning/25">
        <p className="text-sm">
          {conflict
            ? "Both your vault's item and the repository's changed since they last agreed, so nothing was applied. Below is what taking theirs would change in yours."
            : review.flags.length > 0
              ? "The repository's change reaches further than text, so it waits for you."
              : "Changes from this repository wait for you to read them first."}
        </p>
        {repo.trust !== "trusted" ? (
          <p
            className="flex items-start gap-3 rounded-xl bg-warning/10 p-3 text-[13px] ring-1 ring-warning/30"
            role="note"
          >
            <TriangleAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            <span>
              Whoever can push to this repository wrote this. Read it as theirs:
              text in a skill becomes instructions your assistants follow.
            </span>
          </p>
        ) : null}
        {resolved.problems.length > 0 ? (
          <p className="text-sm text-destructive" role="alert">
            {resolved.problems.join(" ")}
          </p>
        ) : null}
        {resolved.missingSecrets.length > 0 ? (
          <p className="text-sm text-warning" role="note">
            It names secrets your vault does not have:{" "}
            {resolved.missingSecrets.map((name) => `"${name}"`).join(", ")}. Add
            them under{" "}
            <Link href="/secrets" className="underline">
              Secrets
            </Link>
            ; until then it is applied without them.
          </p>
        ) : null}

        <RepoFilesReview
          flags={review.flags}
          files={review.files}
          whole={Object.entries(incoming.files)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, text]) => ({ path, text }))}
          caption={
            conflict
              ? "What taking theirs changes in yours"
              : "What changes in your vault"
          }
        />

        {conflict ? (
          <p className="text-[13px] text-muted-foreground">
            Keep mine leaves your item as it is
            {item.bidirectional && repo.access === "write"
              ? " and pushes it over the repository's"
              : ""}
            ; take theirs applies the repository&apos;s exactly as shown. Or let
            an assistant help: one that may manage endpoints finds it with
            search (ref <code>{`${REPO_REF}${item.id}`}</code>), merges both
            sides and asks you with its review, here in PCP.
          </p>
        ) : null}

        {resolved.problems.length === 0 ? (
          <ChangeAnswer
            itemId={item.id}
            sha={pending.sha}
            hash={pending.hash}
            conflict={conflict}
          />
        ) : conflict ? (
          <ChangeAnswer
            itemId={item.id}
            sha={pending.sha}
            hash={pending.hash}
            conflict
          />
        ) : null}
      </Card>
    </PageColumn>
  )
}
