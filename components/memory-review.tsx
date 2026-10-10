import { Badge } from "@/components/ui/badge"
import type { MemoryShown } from "@/lib/core/memories"

/**
 * The memory a request is about, set apart so it is the first thing read:
 * the path above it, and the text it replaces, when it changes, above that.
 * The text is shown whole.
 */
export function MemoryReview({
  memory,
  asking,
}: {
  memory: MemoryShown
  asking: string
}) {
  const text = "whitespace-pre-wrap break-words"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <code className="break-all">{memory.path}</code>
        {memory.newPath ? (
          <>
            <span aria-hidden>→</span>
            <span className="sr-only">moves to</span>
            <code className="break-all">{memory.newPath}</code>
          </>
        ) : null}
        {memory.always && asking !== "memory_share" ? (
          <Badge variant="secondary">Read in every conversation</Badge>
        ) : null}
      </div>
      {memory.before !== null ? (
        <figure className="m-0 flex flex-col gap-1.5">
          <figcaption className="text-xs font-medium text-muted-foreground">
            Now
          </figcaption>
          <blockquote
            className={`${text} m-0 rounded-xl border border-dashed border-separator p-4 text-sm text-muted-foreground`}
          >
            {memory.before}
          </blockquote>
        </figure>
      ) : null}
      <figure className="m-0 flex flex-col gap-1.5">
        {memory.before !== null ? (
          <figcaption className="text-xs font-medium text-muted-foreground">
            After the change
          </figcaption>
        ) : null}
        <blockquote
          className={`${text} m-0 rounded-xl bg-field p-4 text-base leading-relaxed ring-1 ring-primary/30`}
          data-testid="memory-text"
        >
          {memory.text}
        </blockquote>
      </figure>
    </div>
  )
}
