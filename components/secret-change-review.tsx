import Link from "next/link"
import { TriangleAlert } from "lucide-react"

import { Badge } from "@kaperkunde/ui/badge"
import type { SecretChangeShown } from "@/lib/core/secret-changes"

/**
 * An assistant's change to one of your secrets (edit_secret, rotate_secret,
 * change_secret_scope, delete_secret), as you read it before answering:
 * each field before and after, what uses the secret now (what a new value
 * reaches, or what breaks), where it may be used, and what still names it
 * by its name. Never its value.
 */
export function SecretChangeReview({ shown }: { shown: SecretChangeShown }) {
  const box =
    "flex flex-col gap-2 rounded-xl bg-field p-4 ring-1 ring-separator"

  return (
    <div className="flex flex-col gap-4" data-testid="secret-change-review">
      {shown.stale ? (
        <p
          className="flex items-start gap-3 rounded-xl bg-warning/10 p-4 ring-1 ring-warning/30"
          role="note"
        >
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <span className="min-w-0 break-words">
            {shown.exists
              ? `"${shown.secretName}" has changed since the assistant asked, so nothing here can be applied. Answer Not now; the assistant can ask again.`
              : "This secret is no longer in PCP, so there is nothing to change."}
          </span>
        </p>
      ) : null}
      {shown.rows.length > 0 ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal" />
              <th className="py-1 pr-3 font-normal">Now</th>
              <th className="py-1 font-normal">After</th>
            </tr>
          </thead>
          <tbody>
            {shown.rows.map((row) => (
              <tr key={row.label} className="border-t border-separator">
                <th className="py-1.5 pr-3 text-left font-medium">
                  {row.label}
                </th>
                <td className="py-1.5 pr-3 break-words">{row.before}</td>
                <td className="py-1.5 break-words">{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className={box}>
        <span className="text-sm font-medium">
          {shown.action === "delete"
            ? "What uses it"
            : shown.action === "rotate"
              ? "Gets the new value"
              : "Uses it now"}
        </span>
        {shown.uses.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {shown.uses.map((use) => (
              <li key={`${use.via}:${use.id}`}>
                <Badge variant="secondary">
                  {use.name} · {use.kind}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">Nothing yet.</p>
        )}
        {shown.sites.length > 0 ? (
          <p className="m-0 text-sm">
            The browser types it at {shown.sites.join(", ")}.
          </p>
        ) : null}
        <p className="m-0 text-sm text-muted-foreground">
          {shown.scope.anywhere
            ? "It may be used anywhere: any server, service or wrapper you approve, and any site after asking you."
            : shown.scope.consumers.length > 0
              ? `It may be used by ${shown.scope.consumers.map((consumer) => consumer.name).join(", ")}.`
              : "No server, service or wrapper may use it yet."}
        </p>
      </div>
      {shown.action === "delete" && shown.blocking.length > 0 ? (
        <p
          className="flex items-start gap-3 rounded-xl bg-warning/10 p-4 ring-1 ring-warning/30"
          role="note"
        >
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <span className="min-w-0 break-words">
            It cannot be deleted while{" "}
            {shown.blocking.map((use) => use.name).join(", ")}{" "}
            {shown.blocking.length === 1 ? "uses" : "use"} it. Change{" "}
            {shown.blocking.length === 1 ? "that" : "those"} on{" "}
            <Link href="/servers" className="underline">
              their pages
            </Link>{" "}
            first, then come back to delete it. Its sites and the tokens allowed
            to have it typed go with it.
          </span>
        </p>
      ) : null}
      {shown.namedBy.length > 0 ? (
        <div className={box}>
          <span className="text-sm font-medium">
            {shown.action === "delete"
              ? "Still name it, and stop finding it"
              : "Name it by its old name, and stop finding it"}
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {shown.namedBy.map((wrapper) => (
              <li key={wrapper.id}>
                {wrapper.name}: {wrapper.tools.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
