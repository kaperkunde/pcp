import { Globe, Lock, TriangleAlert } from "lucide-react"
import Link from "next/link"
import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import {
  ShareConfirm,
  ShareHits,
  type HitView,
} from "@/components/share-review"
import { Diff } from "@/components/skill-review"
import { Badge } from "@/components/ui/badge"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
import { isPcpError } from "@/lib/core/errors"
import { openShareRequest } from "@/lib/core/permissions"
import type { ItemKind } from "@/lib/core/repos/layout"
import { ITEM_DIRS } from "@/lib/core/repos/layout"
import {
  REVIEW_CHANGED,
  shareReview,
  type ShareFile,
  type ShareReview,
} from "@/lib/core/repos/share-review"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Push to a repository" }

export const dynamic = "force-dynamic"

const KIND: Record<ItemKind, string> = {
  skill: "skill",
  wrapper: "wrapper",
  flow: "browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
}

const CHANGE_LABEL = {
  added: "New file",
  changed: "Changed",
  removed: "Removed",
  same: "Unchanged",
} as const

function listOf(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function itemOf(value: string): { kind: ItemKind; id: string } | null {
  const at = value.indexOf(":")
  const kind = value.slice(0, at)

  return at > 0 && kind in ITEM_DIRS
    ? { kind: kind as ItemKind, id: value.slice(at + 1) }
    : null
}

function anchor(fileIndex: number, line: number): string {
  return `file-${fileIndex}-L${line}`
}

/** A file in full, its lines numbered, what looks personal marked. */
function FileText({
  file,
  index,
  marks,
}: {
  file: ShareFile
  index: number
  /** By line: the columns and lengths of what looks personal there. */
  marks: Map<number, Array<{ column: number; length: number }>>
}) {
  const lines = file.text.replace(/\r\n?/g, "\n").split("\n")

  return (
    <pre className="m-0 max-h-[36rem] overflow-auto rounded-xl bg-field py-3 text-[13px] leading-relaxed">
      {lines.map((text, at) => {
        const number = at + 1
        const here = (marks.get(number) ?? []).sort(
          (a, b) => a.column - b.column,
        )
        const parts: React.ReactNode[] = []
        let from = 0

        for (const mark of here) {
          const start = mark.column - 1

          if (start < from) {
            continue
          }

          parts.push(text.slice(from, start))
          parts.push(
            <mark
              key={start}
              className="rounded-sm bg-warning/30 px-0.5 text-foreground"
            >
              {text.slice(start, start + mark.length)}
            </mark>,
          )
          from = start + mark.length
        }

        parts.push(text.slice(from))

        return (
          <span
            key={number}
            id={anchor(index, number)}
            className={cn(
              "flex scroll-mt-24 gap-3 px-3 target:bg-primary/15",
              here.length > 0 && "bg-warning/10",
            )}
          >
            <span
              aria-hidden
              className="w-8 shrink-0 text-right text-muted-foreground/60 select-none"
            >
              {number}
            </span>
            <span className="min-w-0 break-words whitespace-pre-wrap">
              {parts}
              {text ? null : " "}
            </span>
          </span>
        )
      })}
    </pre>
  )
}

function Banner({ review }: { review: ShareReview }) {
  const repo = `${review.repo.owner}/${review.repo.name}`

  if (review.public) {
    return (
      <div
        className="flex items-start gap-3 rounded-xl bg-warning/15 p-4 text-sm ring-1 ring-warning/50"
        role="note"
        data-testid="share-public"
      >
        <Globe aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="flex flex-col gap-1">
          <strong className="text-[15px]">This will be public</strong>
          <span>
            {review.repo.visibility === "public"
              ? `Anyone can read ${repo}, and what is pushed stays in its history even if you take it out later.`
              : `GitHub has not told PCP whether ${repo} is private, so PCP treats it as public.`}{" "}
            Everything that looks personal below is ticked or fixed before you
            can confirm.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex items-start gap-3 rounded-xl bg-card p-4 text-sm ring-1 ring-separator"
      role="note"
      data-testid="share-private"
    >
      <Lock
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <span>
        {repo} is private: only the people GitHub lets read it see this. What
        looks personal below is advice.
      </span>
    </div>
  )
}

/**
 * The review before an item of the vault goes to a repository, used
 * wherever a push starts: every file in full (and what changes, against
 * what the repository has), what stays in the vault, and what looks
 * personal, with what fixes it. Confirm pushes exactly what is shown
 * (lib/core/repos/share-review.ts). Several items chosen together are
 * reviewed one after another, each on its own.
 */
export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const query = await searchParams
  const items = listOf(query.item).filter((value) => itemOf(value))
  const back = { href: `/settings/repositories/${id}`, label: "Repository" }
  const first = items[0] ? itemOf(items[0]) : null
  let review: ShareReview | null = null
  let failure: string | null = null

  if (first) {
    try {
      review = await shareReview(ctx, id, first, {
        publicUrl: await publicUrlFor(ctx),
      })
    } catch (error) {
      if (!isPcpError(error)) {
        throw error
      }

      failure = error.message
    }
  }

  if (!review) {
    return (
      <PageColumn width="narrow">
        <PageHeader back={back} title="Push to a repository" />
        <p className="text-muted-foreground" role="alert">
          {failure ?? "Choose an item to push on the repository's page."}
        </p>
      </PageColumn>
    )
  }

  const repo = `${review.repo.owner}/${review.repo.name}`
  // An assistant's proposal this review answers, while it is open and about
  // this item: Confirm then answers it, and the commit names the token.
  const asked =
    typeof query.request === "string"
      ? await openShareRequest(ctx, query.request)
      : null
  const proposal =
    asked &&
    asked.repoId === id &&
    first &&
    asked.item.kind === first.kind &&
    asked.item.id === first.id
      ? asked
      : null
  const target = {
    repoId: id,
    items: proposal ? items.slice(0, 1) : items,
    request: proposal?.id ?? null,
  }
  const fileIndex = new Map(review.files.map((file, at) => [file.path, at]))
  const marks = new Map<
    string,
    Map<number, Array<{ column: number; length: number }>>
  >()

  for (const hit of review.hits) {
    for (const place of hit.locations) {
      const byLine = marks.get(place.path) ?? new Map()
      byLine.set(place.line, [
        ...(byLine.get(place.line) ?? []),
        { column: place.column, length: hit.match.length },
      ])
      marks.set(place.path, byLine)
    }
  }

  const hits: HitView[] = review.hits.map((hit) => ({
    id: hit.id,
    label: hit.label,
    match: hit.match,
    fixes: hit.fixes,
    places: hit.locations.map((place) => ({
      href: `#${anchor(fileIndex.get(place.path) ?? 0, place.line)}`,
      text: `${place.path.slice(place.path.lastIndexOf("/") + 1)}:${place.line}`,
    })),
  }))
  const written = review.files.filter((file) => file.change !== "removed")
  const changed = review.files.filter(
    (file) => file.change !== "same" && file.diff,
  )
  const removed = review.files.filter((file) => file.change === "removed")

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={back}
        title={`Push ${review.item.displayName} to ${repo}`}
        description={
          <>
            The {KIND[review.item.kind]} as it goes to{" "}
            <code className="text-sm break-all">{review.root}</code> on{" "}
            {review.repo.branch}
            {items.length > 1
              ? `, then ${items.length - 1} more, each reviewed on its own`
              : ""}
            .
          </>
        }
      />

      {query.changed ? (
        <p
          className="flex items-start gap-3 rounded-xl bg-warning/10 p-4 text-sm ring-1 ring-warning/30"
          role="alert"
        >
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          {REVIEW_CHANGED}
        </p>
      ) : null}
      {typeof query.pushed === "string" ? (
        <p className="text-sm text-muted-foreground" role="status">
          Pushed {query.pushed}. Next:
        </p>
      ) : null}
      {query.fixed ? (
        <p className="text-sm text-muted-foreground" role="status">
          Changed in your vault. Here is what would be pushed now.
        </p>
      ) : null}

      {proposal ? (
        <div
          className="flex flex-col gap-1 rounded-xl bg-card p-4 text-sm ring-1 ring-separator"
          role="note"
          data-testid="share-proposal"
        >
          <strong>Proposed by the token “{proposal.tokenName}”</strong>
          {proposal.message ? (
            <span className="break-words whitespace-pre-wrap text-muted-foreground">
              {proposal.message}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            Confirm answers its request: the assistant hears what was pushed.
          </span>
        </div>
      ) : typeof query.request === "string" ? (
        <p className="text-sm text-muted-foreground" role="status">
          The assistant&apos;s request for this is no longer open: a push from
          here is your own.
        </p>
      ) : null}

      <Banner review={review} />

      {review.blocked ? (
        <p className="text-destructive" role="alert">
          {review.blocked}
        </p>
      ) : null}

      <ListSection
        title={`What looks personal (${review.hits.length})`}
        description={
          review.public
            ? "Fix each one here, or tick it as fine to publish."
            : "Advice: the repository is private."
        }
      >
        <ShareHits
          hits={hits}
          publicRepo={review.public}
          target={target}
          item={{
            description: review.item.description,
            displayName: review.item.displayName,
            name: review.item.name,
          }}
          pageHref={review.item.href}
        />
      </ListSection>

      {changed.length > 0 ? (
        <ListSection
          title="What changes in the repository"
          description={`Against what ${repo} has now.`}
        >
          {changed.map((file) => (
            <figure key={file.path} className="m-0 flex flex-col gap-1.5">
              <figcaption className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <code className="break-all">{file.path}</code>
                <Badge
                  variant={
                    file.change === "removed" ? "destructive" : "secondary"
                  }
                >
                  {CHANGE_LABEL[file.change]}
                </Badge>
              </figcaption>
              <Diff lines={file.diff!} />
            </figure>
          ))}
        </ListSection>
      ) : review.state === "same" ? (
        <p className="text-sm text-muted-foreground">
          {repo} has it the same already: confirming pushes nothing.
        </p>
      ) : null}

      <ListSection
        title="Every file in full"
        description={`${written.length} file${written.length === 1 ? "" : "s"}, as they are written to ${review.root}.`}
      >
        <div className="flex flex-col gap-4" data-testid="share-files">
          {written.map((file) => (
            <figure key={file.path} className="m-0 flex flex-col gap-1.5">
              <figcaption className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <code className="break-all">{file.path}</code>
                <Badge variant="secondary">{CHANGE_LABEL[file.change]}</Badge>
              </figcaption>
              <FileText
                file={file}
                index={fileIndex.get(file.path) ?? 0}
                marks={marks.get(file.path) ?? new Map()}
              />
            </figure>
          ))}
          {removed.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Removed from the repository:{" "}
              {removed.map((file) => file.path).join(", ")}
            </p>
          ) : null}
        </div>
      </ListSection>

      <ListSection
        title="Stays private"
        description="Never in a repository: each of your servers' own, and yours."
      >
        <List data-testid="share-private-panel">
          {review.staysPrivate.map((line) => (
            <ListRow
              key={line.label}
              title={line.label}
              description={<span className="break-words">{line.value}</span>}
              trailing={
                <RowValue>
                  <Lock aria-hidden className="size-3.5" />
                  <span className="sr-only">Private</span>
                </RowValue>
              }
            />
          ))}
        </List>
      </ListSection>

      {review.blocked ? null : (
        <ShareConfirm
          target={target}
          basis={review.basis}
          hitCount={review.hits.length}
          publicRepo={review.public}
          label={
            review.state === "same"
              ? "Link it"
              : `Push to ${review.public ? "public " : ""}${repo}`
          }
        />
      )}

      <p className="text-center text-xs text-muted-foreground">
        <Link href={back.href} className="hover:underline">
          Not now
        </Link>
      </p>
    </PageColumn>
  )
}
