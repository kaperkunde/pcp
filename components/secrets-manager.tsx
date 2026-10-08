"use client"

import { useActionState, useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  createSecretAction,
  deleteSecretAction,
  revealSecretAction,
  updateSecretAction,
  type SecretActionResult,
} from "@/lib/actions/secrets"
import type { SecretSummary } from "@/lib/core/secrets"

export function SecretsManager({ secrets }: { secrets: SecretSummary[] }) {
  return (
    <div className="flex flex-col gap-6">
      <AddSecretForm />
      <Card>
        <CardHeader>
          <CardTitle>Stored secrets ({secrets.length})</CardTitle>
          <CardDescription>
            Values are encrypted at rest and only ever sent to the server that
            uses them. Reveal one to check it; edit it to rotate it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {secrets.length === 0 ? (
            <p className="text-muted-foreground">Nothing stored yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {secrets.map((secret) => (
                <SecretRow key={secret.id} secret={secret} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AddSecretForm() {
  const [state, action] = useActionState<SecretActionResult, FormData>(
    createSecretAction,
    { status: "idle" },
  )
  // A fresh key after each success empties the form.
  const formKey = state.status === "ok" ? state.id : "new"

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a secret</CardTitle>
        <CardDescription>
          An API key, a personal access token, a password: whatever an MCP
          server needs to be sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form key={formKey} action={action} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="secret-name">
              <Input
                id="secret-name"
                name="name"
                required
                maxLength={100}
                placeholder="GitHub token"
              />
            </Field>
            <Field label="Description (optional)" htmlFor="secret-description">
              <Input
                id="secret-description"
                name="description"
                maxLength={500}
                placeholder="Personal access token, repo scope"
              />
            </Field>
          </div>
          <Field label="Value" htmlFor="secret-value">
            <Textarea
              id="secret-value"
              name="value"
              required
              autoComplete="off"
              spellCheck={false}
              className="min-h-12 font-mono"
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton pendingText="Saving…">Save secret</SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
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

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" disabled={pending} onClick={reveal}>
            {revealed !== null ? "Hide" : "Reveal"}
          </Button>
          {!managed ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Cancel" : "Edit"}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" disabled={pending} onClick={remove}>
            Delete
          </Button>
        </div>
      </div>
      {secret.description ? (
        <p className="text-muted-foreground">{secret.description}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Updated <LocalDate value={secret.updatedAt} /> · last used{" "}
        <LocalDate value={secret.lastUsedAt} />
      </p>
      {revealed !== null ? (
        <pre className="max-h-48 overflow-auto rounded-md border border-input bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all">
          {revealed}
        </pre>
      ) : null}
      {editing ? (
        <form
          action={action}
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
        >
          <input type="hidden" name="id" value={secret.id} />
          <div className="grid gap-3 sm:grid-cols-2">
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
              className="min-h-12 font-mono"
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton size="sm" pendingText="Saving…">
              Save
            </SubmitButton>
          </div>
        </form>
      ) : null}
      <FormError error={error} />
    </li>
  )
}
