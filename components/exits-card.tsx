"use client"

import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { List, ListSection } from "@/components/ui/list"
import {
  createExitAction,
  deleteExitAction,
  updateExitAction,
} from "@/lib/actions/exits"
import type { ExitView } from "@/lib/core/exits/exits"
import type { ActionState } from "@/lib/server/action-state"

const rowClassName =
  "flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"

/**
 * The exits that leave from this SSH server: web fetch and the browser can
 * send a request or open a tab from here instead of from PCP's own address,
 * for the tokens you allow on their pages. You add, rename and remove them;
 * an assistant only names one.
 */
export function ExitsCard({
  serverId,
  exits,
}: {
  serverId: string
  exits: ExitView[]
}) {
  return (
    <ListSection
      title="Exits"
      description={
        <>
          An exit lets web fetch and the browser go out from this server instead
          of from PCP&apos;s own address: sites see this server&apos;s address.
          PCP opens a connection through SSH to each site it checked (never to
          this server itself or, unless you allow private addresses for a token,
          its network) and looks names up over HTTPS from here. The server must
          allow TCP forwarding for the login (<code>AllowTcpForwarding</code>;
          PCP&apos;s key without <code>restrict</code> or{" "}
          <code>no-port-forwarding</code>). Each token may use an exit only once
          you allow it on the token&apos;s page.
        </>
      }
      data-testid="ssh-exits"
    >
      <List as="ul">
        {exits.map((exit) => (
          <ExitRow key={exit.id} serverId={serverId} exit={exit} />
        ))}
        <li>
          <AddExitForm serverId={serverId} />
        </li>
      </List>
    </ListSection>
  )
}

function ExitRow({ serverId, exit }: { serverId: string; exit: ExitView }) {
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (editing) {
    return (
      <li>
        <EditExitForm
          serverId={serverId}
          exit={exit}
          onDone={() => setEditing(false)}
        />
      </li>
    )
  }

  return (
    <li className={rowClassName}>
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <code className="text-[13px]">{exit.name}</code>
        <span className="text-xs text-muted-foreground">
          {exit.label || "No label"}
        </span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => setEditing(true)}
      >
        Edit
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Remove the exit ${exit.name}? Every token's level for it goes too.`,
            )
          ) {
            return
          }

          startTransition(async () => {
            const result = await deleteExitAction(serverId, exit.id)
            setError(result.status === "error" ? result.error : null)
          })
        }}
      >
        Remove
      </Button>
      <FormError error={error} className="basis-full" />
    </li>
  )
}

function ExitFields({
  idPrefix,
  name = "",
  label = "",
}: {
  idPrefix: string
  name?: string
  label?: string
}) {
  return (
    <>
      <label htmlFor={`${idPrefix}-name`} className="sr-only">
        Name
      </label>
      <Input
        id={`${idPrefix}-name`}
        name="name"
        required
        maxLength={40}
        pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
        defaultValue={name}
        placeholder="Name, like us-vps"
        autoComplete="off"
        className="min-w-0 flex-1 basis-32"
      />
      <label htmlFor={`${idPrefix}-label`} className="sr-only">
        Where it comes out
      </label>
      <Input
        id={`${idPrefix}-label`}
        name="label"
        maxLength={80}
        defaultValue={label}
        placeholder="Where it comes out, like US — home VPS"
        autoComplete="off"
        className="min-w-0 flex-1 basis-48"
      />
    </>
  )
}

function AddExitForm({ serverId }: { serverId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(
    createExitAction.bind(null, serverId),
    { status: "idle" },
  )

  return (
    <form action={action} className={rowClassName}>
      <ExitFields idPrefix={`exit-new-${serverId}`} />
      <SubmitButton size="sm" pendingText="Adding…">
        Add exit
      </SubmitButton>
      <FormError
        error={state.status === "error" ? state.error : null}
        className="basis-full"
      />
      <FormNote
        message={state.status === "ok" ? "Added." : null}
        className="basis-full"
      />
    </form>
  )
}

function EditExitForm({
  serverId,
  exit,
  onDone,
}: {
  serverId: string
  exit: ExitView
  onDone: () => void
}) {
  const [state, action] = useActionState<ActionState, FormData>(
    async (previous: ActionState, formData: FormData) => {
      const result = await updateExitAction(
        serverId,
        exit.id,
        previous,
        formData,
      )
      if (result.status === "ok") onDone()
      return result
    },
    { status: "idle" },
  )

  return (
    <form action={action} className={rowClassName}>
      <ExitFields
        idPrefix={`exit-${exit.id}`}
        name={exit.name}
        label={exit.label}
      />
      <SubmitButton size="sm" pendingText="Saving…">
        Save
      </SubmitButton>
      <Button variant="secondary" size="sm" type="button" onClick={onDone}>
        Cancel
      </Button>
      <FormError
        error={state.status === "error" ? state.error : null}
        className="basis-full"
      />
    </form>
  )
}
