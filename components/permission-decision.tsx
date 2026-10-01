"use client"

import { useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { decidePermissionAction } from "@/lib/actions/permissions"
import type { PermissionDecision as Decision } from "@/lib/core/constants"
import { cn } from "@/lib/utils"

/** The answers that carry out the request, rather than turn it down. */
const AGREES: Decision[] = ["allow_once", "always"]

/**
 * The owner's buttons for something an assistant asked for. Answering runs
 * the call there and then; the page around it re-renders with the outcome.
 *
 * A new server that sends a secret PCP does not hold yet asks for its value
 * here, the one place it is typed in (`secret`); with `exists`, a secret of
 * that name was added since and is used when the field is left empty.
 */
export function PermissionDecision({
  id,
  decisions,
  secret,
}: {
  id: string
  decisions: Array<{ value: Decision; label: string }>
  secret?: { name: string; exists: boolean } | null
}) {
  const [pending, startTransition] = useTransition()
  const [chosen, setChosen] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secretValue, setSecretValue] = useState("")
  const [done, setDone] = useState<{
    message: string
    isError: boolean
  } | null>(null)

  function decide(value: Decision) {
    const agrees = AGREES.includes(value)

    if (secret && agrees && !secret.exists && !secretValue) {
      setError(`Enter the value of the secret "${secret.name}" first.`)
      return
    }

    setChosen(value)
    setError(null)

    startTransition(async () => {
      const result = await decidePermissionAction(
        id,
        value,
        secret && agrees && secretValue ? secretValue : undefined,
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
      {secret ? (
        <Field
          label={`Value of the secret "${secret.name}"`}
          htmlFor={`permission-${id}-secret`}
          hint={
            secret.exists
              ? `You have added a secret with this name since; leave this empty to use it, or enter a value to save a new one.`
              : "The key or token itself. It is saved under Secrets, encrypted, and sent only to the address above; the assistant never sees it."
          }
        >
          <Input
            id={`permission-${id}-secret`}
            type="password"
            autoComplete="off"
            value={secretValue}
            onChange={(event) => setSecretValue(event.target.value)}
            disabled={pending}
          />
        </Field>
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
