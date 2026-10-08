"use client"

import { useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import { decidePermissionAction } from "@/lib/actions/permissions"
import {
  ALLOW_FOR_MINUTES,
  DEFAULT_ALLOW_FOR_MINUTES,
  allowForLabel,
  type PermissionDecision as Decision,
} from "@/lib/core/constants"
import { cn } from "@/lib/utils"

/** The answers that carry out the request, rather than turn it down. */
const AGREES: Decision[] = ["allow_once", "allow_for", "always"]

/**
 * The owner's buttons for something an assistant asked for. Answering runs
 * the call there and then; the page around it re-renders with the outcome.
 *
 * A new server that sends a secret PCP does not hold yet asks for its value
 * here, the one place it is typed in (`secret`); with `exists`, a secret of
 * that name was added since and is used when the field is left empty. With
 * `clientId` it is that OAuth client's secret, which may be left empty
 * (`optional`) for a client without one.
 *
 * A memory to share offers a toggle for reading it in every conversation
 * (`every`), ticked when the assistant asked for that; it holds whether the
 * owner shares the memory or keeps it for that assistant.
 *
 * "Allow for" comes with how long, chosen beside its button.
 */
export function PermissionDecision({
  id,
  decisions,
  secret,
  every,
}: {
  id: string
  decisions: Array<{ value: Decision; label: string }>
  secret?: {
    name: string
    exists: boolean
    optional?: boolean
    clientId?: string | null
    /** The user name this is the password for (basic authentication). */
    login?: string | null
  } | null
  every?: { asked: boolean } | null
}) {
  const [pending, startTransition] = useTransition()
  const [chosen, setChosen] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secretValue, setSecretValue] = useState("")
  const [always, setAlways] = useState(every?.asked === true)
  const [minutes, setMinutes] = useState<number>(DEFAULT_ALLOW_FOR_MINUTES)
  const [done, setDone] = useState<{
    message: string
    isError: boolean
  } | null>(null)

  function decide(value: Decision) {
    const agrees = AGREES.includes(value)

    if (
      secret &&
      agrees &&
      !secret.exists &&
      !secret.optional &&
      !secretValue
    ) {
      setError(
        secret.login
          ? `Enter the password for ${secret.login} first.`
          : `Enter the value of the secret "${secret.name}" first.`,
      )
      return
    }

    setChosen(value)
    setError(null)

    startTransition(async () => {
      const result = await decidePermissionAction(
        id,
        value,
        secret && agrees && secretValue ? secretValue : undefined,
        every ? always : undefined,
        value === "allow_for" ? minutes : undefined,
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
      <div className="flex flex-col gap-2">
        <p
          className={cn(
            "whitespace-pre-wrap break-words",
            done.isError && "text-destructive",
          )}
          data-testid="permission-outcome"
        >
          {done.message}
        </p>
        <p className="text-muted-foreground">
          Tell the assistant that asked that you answered, and it carries on.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {secret ? (
        <Field
          label={
            secret.clientId
              ? `Client secret of the OAuth client "${secret.clientId}"`
              : secret.login
                ? `Password for ${secret.login}`
                : `Value of the secret "${secret.name}"`
          }
          htmlFor={`permission-${id}-secret`}
          hint={
            secret.exists
              ? `You have added a secret named "${secret.name}" since; leave this empty to use it, or enter a value to save a new one.`
              : secret.clientId
                ? `From the provider's developer settings, where you created the client. It is saved under Secrets as "${secret.name}", encrypted, and sent only to the token address above; the assistant never sees it. Leave it empty for a client without a secret.`
                : secret.login
                  ? `An app password, if the server offers them, rather than your own. It is saved under Secrets as "${secret.name}", encrypted, and sent only to the address above; the assistant never sees it.`
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
      {every ? (
        <div className="flex flex-col gap-1.5">
          <Label className="font-normal" htmlFor={`permission-${id}-always`}>
            <Checkbox
              id={`permission-${id}-always`}
              checked={always}
              onChange={(event) => setAlways(event.target.checked)}
              disabled={pending}
            />
            Read in every conversation
          </Label>
          <p className="text-xs text-muted-foreground">
            {every.asked ? "The assistant asked for this. " : null}
            It comes with PCP&apos;s instructions, as your own words, so an
            assistant follows it from its first reply: every assistant if you
            share it, only this one if you keep it for this assistant.
          </p>
        </div>
      ) : null}
      <FormError error={error} />
      <div className="flex flex-wrap gap-2">
        {decisions.map((decision, index) => {
          const button = (
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
              {pending && chosen === decision.value
                ? "Working…"
                : decision.value === "allow_for"
                  ? `${decision.label} ${allowForLabel(minutes)}`
                  : decision.label}
            </Button>
          )

          return decision.value === "allow_for" ? (
            <div key={decision.value} className="flex items-center gap-1">
              {button}
              <Select
                aria-label="How long"
                value={String(minutes)}
                onChange={(event) => setMinutes(Number(event.target.value))}
                disabled={pending}
                className="h-7 w-auto py-0 text-[0.8rem]"
              >
                {ALLOW_FOR_MINUTES.map((option) => (
                  <option key={option} value={option}>
                    {allowForLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            button
          )
        })}
      </div>
    </div>
  )
}
