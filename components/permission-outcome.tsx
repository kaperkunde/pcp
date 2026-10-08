import { StatusDot } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * What came of a request the owner answered: the status line, what the
 * request returned (an error in red), and the reminder to tell the
 * assistant, which then carries on.
 */
export function PermissionOutcome({
  status,
  tone = "ok",
  outcome,
  outcomeIsError = false,
  tell = true,
}: {
  /** The status line ("You allowed this and it ran."). */
  status?: string | null
  tone?: "ok" | "warning" | "error" | "off"
  /** What the request returned, shown whole. */
  outcome?: string | null
  outcomeIsError?: boolean
  /** Whether to remind the owner to tell the assistant. */
  tell?: boolean
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl bg-field p-4 ring-1 ring-separator"
      data-testid="permission-outcome"
    >
      {status ? (
        <p className="flex items-center gap-2.5 font-medium">
          <StatusDot tone={tone} />
          {status}
        </p>
      ) : null}
      {outcome ? (
        <p
          className={cn(
            "break-words whitespace-pre-wrap",
            outcomeIsError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {outcome}
        </p>
      ) : null}
      {tell ? (
        <p className="text-[13px] text-muted-foreground">
          Tell the assistant that asked that you answered, and it carries on.
        </p>
      ) : null}
    </div>
  )
}
