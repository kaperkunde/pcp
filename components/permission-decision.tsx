"use client"

import { useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import {
  DECISION_BUTTON,
  PermissionActions,
  QUIET_DECISION,
} from "@/components/permission-actions"
import { PermissionOutcome } from "@/components/permission-outcome"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import { decidePermissionAction } from "@/lib/actions/permissions"
import {
  ALLOW_FOR_MINUTES,
  DEFAULT_ALLOW_FOR_MINUTES,
  allowForLabel,
  type PermissionDecision as Decision,
} from "@/lib/core/constants"

/** The answers that carry out the request, rather than turn it down. */
const AGREES: Decision[] = ["allow_once", "allow_for", "always"]

/** Answers that settle more than this one request, or throw it away: quiet. */
const QUIET: Decision[] = ["block", "discard"]

/**
 * The owner's buttons for something an assistant asked for. Answering runs
 * the call there and then; the page around it re-renders with the outcome.
 *
 * The main yes ("Allow once", or the kind's own) is the one teal button, last
 * at the right; the refusal and the answers that settle later calls are
 * grey buttons before it; Block and Discard are quiet text under them.
 *
 * A new server that sends a secret PCP does not hold yet asks for its value
 * here, the one place it is typed in (`secret`); with `exists`, a secret of
 * that name was added since and is used when the field is left empty. With
 * `clientId` it is that OAuth client's secret, which may be left empty
 * (`optional`) for a client without one.
 *
 * A memory to share offers a switch for reading it in every conversation
 * (`every`), on when the assistant asked for that; it holds whether the
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
      <PermissionOutcome
        outcome={done.message}
        outcomeIsError={done.isError}
        tone={done.isError ? "error" : "ok"}
      />
    )
  }

  function labelOf(decision: { value: Decision; label: string }): string {
    return pending && chosen === decision.value
      ? "Working…"
      : decision.value === "allow_for"
        ? `${decision.label} ${allowForLabel(minutes)}`
        : decision.label
  }

  const primary = decisions.find((decision) => decision.value === "allow_once")
  const allowFor = decisions.find((decision) => decision.value === "allow_for")
  // The grey buttons, refusal first: Not now, Always allow.
  const order: Decision[] = ["decline", "always"]
  const others = decisions
    .filter(
      (decision) =>
        decision !== primary &&
        decision !== allowFor &&
        !QUIET.includes(decision.value),
    )
    .sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value))
  const quiet = decisions.filter((decision) => QUIET.includes(decision.value))

  return (
    <div className="flex flex-col gap-5">
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
        <List>
          <SwitchRow
            id={`permission-${id}-always`}
            label="Read in every conversation"
            description={
              <>
                {every.asked ? "The assistant asked for this. " : null}
                It comes with PCP&apos;s instructions, as your own words, so an
                assistant follows it from its first reply: every assistant if
                you share it, only this one if you keep it for this assistant.
              </>
            }
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
            disabled={pending}
          />
        </List>
      ) : null}
      <FormError error={error} />
      <PermissionActions
        note="Nothing runs until you answer. Then tell the assistant you have."
        others={others.map((decision) => (
          <Button
            key={decision.value}
            type="button"
            size="lg"
            variant="secondary"
            className={DECISION_BUTTON}
            disabled={pending}
            onClick={() => decide(decision.value)}
          >
            {labelOf(decision)}
          </Button>
        ))}
        beside={
          allowFor ? (
            <div className="flex gap-2 sm:items-center">
              <Button
                type="button"
                variant="secondary"
                className="flex-1 sm:flex-none"
                disabled={pending}
                onClick={() => decide(allowFor.value)}
              >
                {labelOf(allowFor)}
              </Button>
              <Select
                aria-label="How long"
                value={String(minutes)}
                onChange={(event) => setMinutes(Number(event.target.value))}
                disabled={pending}
                className="h-9 w-auto"
              >
                {ALLOW_FOR_MINUTES.map((option) => (
                  <option key={option} value={option}>
                    {allowForLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
          ) : undefined
        }
        primary={
          primary ? (
            <Button
              type="button"
              size="lg"
              className={DECISION_BUTTON}
              disabled={pending}
              onClick={() => decide(primary.value)}
            >
              {labelOf(primary)}
            </Button>
          ) : undefined
        }
        quiet={quiet.map((decision) => (
          <Button
            key={decision.value}
            type="button"
            variant="plain"
            className={QUIET_DECISION}
            disabled={pending}
            onClick={() => decide(decision.value)}
          >
            {labelOf(decision)}
          </Button>
        ))}
      />
    </div>
  )
}
