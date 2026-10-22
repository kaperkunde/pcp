import { TriangleAlert } from "lucide-react"

import { Diff } from "@/components/skill-review"
import { Badge } from "@/components/ui/badge"
import type { RepoShown } from "@/lib/core/repos/assist"
import type { FileChange, ReviewFlag } from "@/lib/core/repos/review"
import { cn } from "@/lib/utils"

const CHANGE_LABEL = {
  added: "New file",
  changed: "Changed",
  removed: "Removed",
  same: "Unchanged",
} as const

/**
 * What a change from a linked repository would do, in full: each flag PCP
 * raised (what would reach further than text), every file line by line
 * against the vault's item, and the whole of every file. Nothing is folded:
 * the owner reads all of it before agreeing (DESIGN.md › What goes where).
 */
export function RepoFilesReview({
  flags,
  files,
  whole,
  caption = "What changes in your vault",
}: {
  flags: ReviewFlag[]
  files: FileChange[]
  whole: Array<{ path: string; text: string }>
  caption?: string
}) {
  const changed = files.filter((file) => file.change !== "same")

  return (
    <div className="flex flex-col gap-5">
      <RepoFlags flags={flags} />

      <section className="flex flex-col gap-3" aria-label={caption}>
        <h2 className="text-[13px] font-semibold text-muted-foreground">
          {caption}
        </h2>
        {changed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No file changes.</p>
        ) : (
          changed.map((file) => (
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
              {file.diff ? <Diff lines={file.diff} /> : null}
            </figure>
          ))
        )}
      </section>

      <section
        className="flex flex-col gap-3"
        aria-label="Every file in full"
        data-testid="repo-files"
      >
        <h2 className="text-[13px] font-semibold text-muted-foreground">
          Every file in full
        </h2>
        {whole.map((file) => (
          <figure key={file.path} className="m-0 flex flex-col gap-1.5">
            <figcaption className="text-xs font-medium text-muted-foreground">
              <code className="break-all">{file.path}</code>
            </figcaption>
            <pre className="m-0 max-h-[36rem] overflow-auto rounded-xl bg-field p-4 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
              {file.text}
            </pre>
          </figure>
        ))}
      </section>
    </div>
  )
}

export function RepoFlags({ flags }: { flags: ReviewFlag[] }) {
  if (flags.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="repo-flags">
        PCP found nothing that reaches further than text.
      </p>
    )
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-xl bg-warning/10 p-4 ring-1 ring-warning/30"
      aria-label="What reaches further"
      data-testid="repo-flags"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <TriangleAlert aria-hidden className="size-4 text-warning" />
        What reaches further ({flags.length})
      </h2>
      <ul className="flex flex-col gap-1.5 text-sm">
        {flags.map((flag, index) => (
          <li key={index} className="break-words">
            <code className="text-xs text-muted-foreground">{flag.path}</code>{" "}
            {flag.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A repo_change request on the permission page: the review, then the files. */
export function RepoReview({ shown }: { shown: RepoShown }) {
  const fromTheirs = shown.fromTheirs.filter((file) => file.change !== "same")

  return (
    <div className="flex flex-col gap-6">
      <section
        className="flex flex-col gap-2"
        aria-label="The assistant's review"
      >
        <h2 className="text-[13px] font-semibold text-muted-foreground">
          The assistant&apos;s review (REVIEW.md)
        </h2>
        <pre
          className="m-0 max-h-[28rem] overflow-auto rounded-xl bg-field p-4 text-[13px] leading-relaxed break-words whitespace-pre-wrap ring-1 ring-primary/30"
          data-testid="repo-review-text"
        >
          {shown.review}
        </pre>
        <p className="text-xs text-muted-foreground">
          The assistant wrote this; PCP&apos;s own flags and the files below are
          what decides.
        </p>
      </section>

      <RepoFilesReview
        flags={shown.flags}
        files={shown.files}
        whole={shown.final}
      />

      {fromTheirs.length > 0 ? (
        <section
          className={cn("flex flex-col gap-3")}
          aria-label="What the assistant changed from the repository's"
        >
          <h2 className="text-[13px] font-semibold text-muted-foreground">
            What the assistant changed from the repository&apos;s version
          </h2>
          {fromTheirs.map((file) => (
            <figure key={file.path} className="m-0 flex flex-col gap-1.5">
              <figcaption className="text-xs font-medium text-muted-foreground">
                <code className="break-all">{file.path}</code>
              </figcaption>
              {file.diff ? <Diff lines={file.diff} /> : null}
            </figure>
          ))}
        </section>
      ) : null}
    </div>
  )
}
