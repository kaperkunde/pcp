"use client"

import { useActionState } from "react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import Link from "next/link"

import { RelativeDate } from "@/components/local-date"
import {
  clearAlertsAction,
  type ServerActionResult,
} from "@/lib/actions/servers"

export type ServerAlert = {
  id: string
  name: string
  message: string
  /** When it last happened. */
  seenAt: Date | null
  /** False when only you can mend it (sign in again): Clear all leaves it. */
  clearable: boolean
}

/**
 * What PCP found wrong with a server, above the list: each says when it
 * last happened, so a stale one is plain, and one button clears them all.
 * A server clears its own once a call to it goes well or a secret it uses
 * is changed.
 */
export function ServerAlerts({ alerts }: { alerts: ServerAlert[] }) {
  const [state, action] = useActionState<ServerActionResult, FormData>(
    clearAlertsAction,
    { status: "idle" },
  )

  if (alerts.length === 0) {
    return state.status === "ok" ? <FormNote message={state.message} /> : null
  }

  return (
    <section
      aria-label="Alerts"
      className="flex flex-col gap-3 rounded-xl bg-card p-4 text-sm ring-1 ring-warning/30"
    >
      <ul className="flex flex-col gap-2">
        {alerts.map((alert) => (
          <li key={alert.id} className="leading-relaxed">
            <Link
              href={`/servers/${alert.id}`}
              className="font-medium text-warning hover:underline"
            >
              {alert.name}
            </Link>{" "}
            <span className="text-muted-foreground">{alert.message}</span>
            {alert.clearable ? null : (
              <>
                {" "}
                <Link
                  href={`/servers/${alert.id}`}
                  className="font-medium text-warning hover:underline"
                >
                  Connect it again
                </Link>
              </>
            )}
            {alert.seenAt ? (
              <span className="block text-xs text-muted-foreground">
                Last seen <RelativeDate value={alert.seenAt} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {alerts.some((alert) => alert.clearable) ? (
        <form action={action} className="flex flex-col gap-2">
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton size="sm" variant="outline" pendingText="Clearing…">
              Clear all
            </SubmitButton>
          </div>
        </form>
      ) : null}
    </section>
  )
}
