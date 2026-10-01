"use client"

import { useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { decidePermissionAction } from "@/lib/actions/permissions"
import {
  MAX_SECRET_VALUE,
  type PermissionDecision as Decision,
} from "@/lib/core/constants"
import { cn } from "@/lib/utils"

/**
 * The owner's buttons for something an assistant asked for. Answering runs
 * the call there and then; the page around it re-renders with the outcome.
 * A new server that sends a secret the owner has not stored yet asks for it
 * here, and agreeing stores it with the server.
 */
export function PermissionDecision({
  id,
  decisions,
  newSecret = null,
}: {
  id: string
  decisions: Array<{ value: Decision; label: string }>
  newSecret?: { name: string } | null
}) {
  const [pending, startTransition] = useTransition()
  const [chosen, setChosen] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secretName, setSecretName] = useState(newSecret?.name ?? "")
  const [secretValue, setSecretValue] = useState("")
  const [done, setDone] = useState<{
    message: string
    isError: boolean
  } | null>(null)

  function decide(value: Decision) {
    const agreeing = value !== "decline" && value !== "block"

    if (newSecret && agreeing && !secretValue.trim()) {
      setError("Enter the secret to add it.")
      return
    }

    setChosen(value)
    setError(null)

    startTransition(async () => {
      const result = await decidePermissionAction(
        id,
        value,
        newSecret && agreeing
          ? { name: secretName, value: secretValue }
          : undefined,
      )

      if (result.status === "error") {
        setError(result.error)
      } else if (result.status === "ok") {
        setDone({ message: result.message, isError: result.isError })
      }
    })
  }

  if (done) {
    return (
      <p
        className={cn(
          "whitespace-pre-wrap break-words",
          done.isError && "text-destructive",
        )}
        data-testid="permission-outcome"
      >
        {done.message}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {newSecret ? (
        <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <Field
            label="Secret value"
            htmlFor={`permission-${id}-secret-value`}
            hint="The API key or token it sends. PCP stores it encrypted under Secrets; the assistant never sees it."
          >
            <Input
              id={`permission-${id}-secret-value`}
              type="password"
              value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)}
              autoComplete="off"
              maxLength={MAX_SECRET_VALUE}
              disabled={pending}
            />
          </Field>
          <Field
            label="Save it as"
            htmlFor={`permission-${id}-secret-name`}
            hint="The name it gets under Secrets; the assistant suggested this one."
          >
            <Input
              id={`permission-${id}-secret-name`}
              value={secretName}
              onChange={(event) => setSecretName(event.target.value)}
              maxLength={100}
              disabled={pending}
            />
          </Field>
        </div>
      ) : null}
      <FormError error={error} />
      <div className="flex flex-wrap gap-2">
        {decisions.map((decision, index) => (
          <Button
            key={decision.value}
            type="button"
            size="sm"
            variant={
              decision.value === "block" || decision.value === "discard"
                ? "destructive"
                : index === 0
                  ? "default"
                  : "outline"
            }
            disabled={pending}
            onClick={() => decide(decision.value)}
          >
            {pending && chosen === decision.value ? "Working…" : decision.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
