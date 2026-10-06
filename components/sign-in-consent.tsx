"use client"

import { useActionState, useEffect, useState, useTransition } from "react"
import type { FormEvent } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { KeepMemoriesField } from "@/components/keep-memories-field"
import { LocalDate } from "@/components/local-date"
import { ManageEndpointsField } from "@/components/manage-endpoints-field"
import { OwnerConfirmFields } from "@/components/owner-confirm-fields"
import { RunCodeField } from "@/components/run-code-field"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { SubmitButton } from "@/components/submit-button"
import { WebFetchField } from "@/components/web-fetch-field"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  approveSignInAction,
  denySignInAction,
  type SignInAnswer,
} from "@/lib/actions/oauth-server"
import type { ServerKind } from "@/lib/core/servers"

/**
 * What the owner sees when an assistant asks to sign in: who asks (the name
 * it gives, and the address it really comes from, since anyone can call
 * themselves "Claude"), where PCP sends them back to, and the token it gets:
 * a new one with the levels chosen here, or the one this app had before.
 * Allowing it asks for the password (or Touch ID) in a form of its own, as
 * making an API token does.
 */
export function SignInConsent({
  request,
  client,
  tokens,
  servers,
  username,
}: {
  /** The sign-in's query, sent back with the answer and checked again. */
  request: string
  client: {
    name: string
    host: string
    fromDocument: boolean
    returnHost: string
  }
  tokens: Array<{ id: string; name: string; createdAt: string }>
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  username: string
}) {
  const [state, action] = useActionState<SignInAnswer, FormData>(
    approveSignInAction,
    { status: "idle" },
  )
  const [connectAs, setConnectAs] = useState(tokens[0]?.id ?? "new")
  const [draft, setDraft] = useState<Array<[string, string]> | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [denyError, setDenyError] = useState<string | null>(null)
  const [denying, startDeny] = useTransition()
  const answered = state.status === "ok" ? state : null

  // The answer is the app's address with the code (or the refusal) on it.
  useEffect(() => {
    if (answered) {
      setLeaving(true)
      window.location.assign(answered.redirect)
    }
  }, [answered])

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const entries: Array<[string, string]> = []

    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string") entries.push([key, value])
    }

    setDraft(entries)
  }

  function deny() {
    startDeny(async () => {
      const result = await denySignInAction(request)

      if (result.status === "ok") {
        setLeaving(true)
        window.location.assign(result.redirect)
      } else if (result.status === "error") {
        setDenyError(result.error)
      }
    })
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">App</dt>
          <dd>
            {client.name}{" "}
            <span className="text-muted-foreground">
              {client.fromDocument
                ? `(identified by ${client.host})`
                : "(registered itself with PCP)"}
            </span>
          </dd>
          <dt className="text-muted-foreground">Sends you back to</dt>
          <dd className="break-all">{client.returnHost}</dd>
        </dl>
        <p className="text-sm text-muted-foreground">
          Only allow this if you just started connecting {client.name} yourself.
          You can change what its token may do, or revoke it, under API tokens
          at any time.
        </p>
        {/* Two forms, as for a new API token: the one with the password holds
            the account and the password and nothing else. */}
        <form onSubmit={review}>
          <fieldset disabled={draft !== null} className="flex flex-col gap-4">
            {tokens.length > 0 ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">Token</legend>
                {tokens.map((token) => (
                  <Label key={token.id} className="font-normal">
                    <input
                      type="radio"
                      name="connectAs"
                      value={token.id}
                      checked={connectAs === token.id}
                      onChange={() => setConnectAs(token.id)}
                      className="accent-primary"
                    />
                    <span>
                      {token.name}, the token it had (made{" "}
                      <LocalDate value={token.createdAt} />
                      ), with its levels and memories
                    </span>
                  </Label>
                ))}
                <Label className="font-normal">
                  <input
                    type="radio"
                    name="connectAs"
                    value="new"
                    checked={connectAs === "new"}
                    onChange={() => setConnectAs("new")}
                    className="accent-primary"
                  />
                  A new token
                </Label>
              </fieldset>
            ) : (
              <input type="hidden" name="connectAs" value="new" />
            )}
            {connectAs === "new" ? (
              <>
                <Field label="Token name" htmlFor="consent-name">
                  <Input
                    id="consent-name"
                    name="name"
                    autoComplete="off"
                    required
                    maxLength={80}
                    defaultValue={client.name}
                  />
                </Field>
                <ServerScopeFields servers={servers} />
                <ManageEndpointsField id="consent-manage" />
                <KeepMemoriesField id="consent-memories" />
                <WebFetchField id="consent-fetch" />
                <RunCodeField id="consent-code" />
                <p className="text-xs text-muted-foreground">
                  Until you set a tool&apos;s level on the token&apos;s page,
                  the assistant asks you before it runs it.
                </p>
              </>
            ) : null}
            {draft === null ? (
              <div className="flex gap-2">
                <Button type="submit">Allow</Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={denying || leaving}
                  onClick={deny}
                >
                  Deny
                </Button>
              </div>
            ) : null}
            <FormError error={denyError} />
          </fieldset>
        </form>
        {draft !== null ? (
          <form
            action={action}
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
          >
            <p className="text-muted-foreground">
              The assistant gets a lasting way into your vault, so PCP asks for
              your password first.
            </p>
            <input type="hidden" name="request" value={request} />
            {draft.map(([key, value], index) => (
              <input key={index} type="hidden" name={key} value={value} />
            ))}
            <OwnerConfirmFields
              idPrefix="consent"
              username={username}
              error={state.status === "error" ? state.error : null}
              autoFocus
            />
            <FormError error={state.status === "error" ? state.error : null} />
            <FormNote
              message={
                leaving ? `Allowed. Taking you back to ${client.name}…` : null
              }
            />
            <div className="flex gap-2">
              <SubmitButton pendingText="Checking…">Confirm</SubmitButton>
              <Button
                type="button"
                variant="outline"
                disabled={leaving}
                onClick={() => setDraft(null)}
              >
                Back
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}
