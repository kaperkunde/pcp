"use client"

import { useActionState, useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { LocalDate, RelativeDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List, ListRow, ListSection } from "@/components/ui/list"
import {
  deleteSecretAction,
  revealSecretAction,
  updateSecretAction,
  type SecretActionResult,
} from "@/lib/actions/secrets"
import type { SecretSummary } from "@/lib/core/secrets"

/**
 * The stored secrets, one row each: its name, what it is for, the servers
 * that use it and when it was last used; Reveal shows the value on the
 * owner's own screen, Edit renames it or rotates its value.
 */
export function SecretsManager({ secrets }: { secrets: SecretSummary[] }) {
  return (
    <ListSection
      title={`Stored secrets (${secrets.length})`}
      description="Values are encrypted at rest and only ever sent to the server that uses them. Reveal one to check it; edit it to rotate it."
    >
      {secrets.length === 0 ? (
        <Card>
          <p className="text-muted-foreground">
            Nothing stored yet. Add a secret for a server that needs a key or a
            token.
          </p>
        </Card>
      ) : (
        <List as="ul">
          {secrets.map((secret) => (
            <SecretRow key={secret.id} secret={secret} />
          ))}
        </List>
      )}
    </ListSection>
  )
}

function SecretRow({ secret }: { secret: SecretSummary }) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [state, action] = useActionState<SecretActionResult, FormData>(
    updateSecretAction,
    { status: "idle" },
  )

  function reveal() {
    if (revealed !== null) {
      setRevealed(null)
      return
    }

    startTransition(async () => {
      const result = await revealSecretAction(secret.id)
      if (result.status === "ok") {
        setRevealed(result.value)
        setError(null)
      } else if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  function remove() {
    if (!window.confirm(`Delete the secret "${secret.name}"?`)) {
      return
    }

    startTransition(async () => {
      const result = await deleteSecretAction(secret.id)
      if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  const managed = secret.kind !== "text"
  const open = revealed !== null || editing || error !== null

  return (
    <ListRow
      as="li"
      className="items-start py-3.5"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{secret.name}</span>
          {managed ? (
            <Badge variant="secondary">
              {secret.kind === "ssh_key" ? "SSH key" : "OAuth tokens"}
            </Badge>
          ) : null}
          {secret.usedBy.map((server) => (
            <Badge key={server.id} variant="outline">
              {server.name}
            </Badge>
          ))}
        </span>
      }
      description={
        <>
          {secret.description ? (
            <span className="block text-sm text-foreground/80">
              {secret.description}
            </span>
          ) : null}
          <span className="block">
            Updated <LocalDate value={secret.updatedAt} /> · last used{" "}
            <RelativeDate value={secret.lastUsedAt} />
          </span>
        </>
      }
      trailing={
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={pending} onClick={reveal}>
            {revealed !== null ? "Hide" : "Reveal"}
          </Button>
          {!managed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Cancel" : "Edit"}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={remove}
          >
            Delete
          </Button>
        </div>
      }
    >
      {open ? (
        <div className="order-last flex basis-full flex-col gap-3">
          {revealed !== null ? (
            <pre className="m-0 max-h-48 overflow-auto rounded-xl bg-field p-3.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap ring-1 ring-separator">
              {revealed}
            </pre>
          ) : null}
          {editing ? (
            <form
              action={action}
              className="flex flex-col gap-4 rounded-xl bg-field p-4 ring-1 ring-separator"
            >
              <input type="hidden" name="id" value={secret.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor={`secret-${secret.id}-name`}>
                  <Input
                    id={`secret-${secret.id}-name`}
                    name="name"
                    defaultValue={secret.name}
                    required
                    maxLength={100}
                  />
                </Field>
                <Field
                  label="Description"
                  htmlFor={`secret-${secret.id}-description`}
                >
                  <Input
                    id={`secret-${secret.id}-description`}
                    name="description"
                    defaultValue={secret.description}
                    maxLength={500}
                  />
                </Field>
              </div>
              <Field
                label="New value"
                htmlFor={`secret-${secret.id}-value`}
                hint="Leave empty to keep the current value."
              >
                <Textarea
                  id={`secret-${secret.id}-value`}
                  name="value"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-14 font-mono"
                />
              </Field>
              <FormError
                error={state.status === "error" ? state.error : null}
              />
              <div>
                <SubmitButton pendingText="Saving…">Save</SubmitButton>
              </div>
            </form>
          ) : null}
          <FormError error={error} />
        </div>
      ) : null}
    </ListRow>
  )
}
