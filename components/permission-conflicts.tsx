import { TriangleAlert } from "lucide-react"
import Link from "next/link"

/**
 * Other requests waiting on the same skill, shared memory or note
 * (PermissionView `conflicts`): each is made on the item as it is now, so
 * approving one makes the others fail. Shown above the answers, in amber,
 * since it changes what the owner's yes does.
 */
export function PermissionConflicts({
  conflicts,
}: {
  conflicts: Array<{ id: string; tokenName: string }>
}) {
  if (conflicts.length === 0) {
    return null
  }

  return (
    <div
      className="flex items-start gap-3 rounded-xl bg-warning/10 p-4 ring-1 ring-warning/30"
      role="note"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-warning"
      />
      <ul className="flex min-w-0 flex-col gap-1 break-words">
        {conflicts.map((conflict) => (
          <li key={conflict.id}>
            Conflicts with request{" "}
            <Link
              href={`/permissions/${encodeURIComponent(conflict.id)}`}
              className="font-mono text-[13px] underline"
            >
              {conflict.id}
            </Link>{" "}
            from {conflict.tokenName}: approving one makes the other fail.
          </li>
        ))}
      </ul>
    </div>
  )
}
