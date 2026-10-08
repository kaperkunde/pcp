"use client"

import {
  startTransition,
  useActionState,
  useEffect,
  useState,
  type FormEvent,
} from "react"

import { touchIdForget } from "@/components/desktop-bridge"
import { FormError } from "@/components/form-status"
import { OwnerConfirmFields } from "@/components/owner-confirm-fields"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { deleteVaultAction } from "@/lib/actions/settings"
import type { ActionState } from "@/lib/server/action-state"

/**
 * Deleting the vault (lib/core/vault-reset.ts): a button that opens the
 * step, a box to tick, and the owner's password or Touch ID. Once it is
 * gone the Mac app forgets its Touch ID key, which opens nothing any more,
 * and the page goes to setup.
 */
export function DeleteVaultCard({ username }: { username: string }) {
  const [open, setOpen] = useState(false)
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(
    deleteVaultAction,
    { status: "idle" },
  )
  // A result the owner has gone back from: its message is not shown again.
  const [dismissed, setDismissed] = useState<ActionState | null>(null)

  useEffect(() => {
    if (state.status === "ok") {
      // A full load: nothing of the deleted vault stays on the page.
      void touchIdForget().then(() => window.location.assign("/setup"))
    }
  }, [state])

  const error =
    state.status === "error" && state !== dismissed ? state.error : null
  const done = state.status === "ok"

  function back() {
    setDismissed(state)
    setOpen(false)
  }

  // Sent from onSubmit rather than <form action>: React empties a form once
  // its action has run, and a refused password should not untick the box.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    // Not from a <form action>, so React is told it is an action's work.
    startTransition(() => dispatch(data))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete vault</CardTitle>
        <CardDescription>
          Deletes everything PCP holds and starts it over from the setup page.
          Export first if you may want any of it back.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {open ? (
          <form
            onSubmit={submit}
            aria-label="Delete vault"
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
          >
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              <li>
                Deleted for good: servers, API endpoints, mail accounts,
                secrets, API tokens, memories, the browser&apos;s sign-ins, the
                request log and your password and recovery key. There is no
                undo.
              </li>
              <li>
                Assistants using an API token stop working at once, and every
                browser is signed out.
              </li>
              <li>
                This machine&apos;s settings stay: pcp.gg, Dynamic DNS, HTTPS,
                updates, cleanup and resources. Turn them off above first if you
                want them gone too.
              </li>
              <li>
                Until PCP is set up again, the first person to open it becomes
                its owner.
              </li>
            </ul>
            <Label className="font-normal">
              <Checkbox name="deleteVault" required />
              Delete everything in this PCP
            </Label>
            {/* Not asked for at once: the box above is ticked first. */}
            <OwnerConfirmFields
              idPrefix="delete-vault-owner"
              username={username}
              error={error}
              autoPrompt={false}
            />
            <FormError error={error} />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="destructive"
                disabled={pending || done}
              >
                {pending || done ? "Deleting…" : "Delete everything"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={back}
                disabled={pending || done}
              >
                Back
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setOpen(true)}
            >
              Delete vault…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
