"use client"

import { useActionState, useEffect, useState, useTransition } from "react"
import type { FormEvent } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { KeepMemoriesField } from "@/components/keep-memories-field"
import { LocalDate } from "@/components/local-date"
import { ManageEndpointsField } from "@/components/manage-endpoints-field"
import { OwnerConfirmFields } from "@/components/owner-confirm-fields"
import { ManageWrappersField } from "@/components/manage-wrappers-field"
import { RunCodeField } from "@/components/run-code-field"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { SubmitButton } from "@/components/submit-button"
import { WebFetchField } from "@/components/web-fetch-field"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Disclosure } from "@/components/ui/disclosure"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
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
    <div className="flex flex-col gap-6">
      <ListSection
        title="Who is asking"
        footer={
          <>
            Only allow this if you just started connecting {client.name}{" "}
            yourself. You can change what its token may do, or revoke it, under
            API tokens at any time.
          </>
        }
      >
        <List>
          <ListRow
            title={client.name}
            description={
              client.fromDocument
                ? `Identified by ${client.host}`
                : "Registered itself with PCP"
            }
          />
          <ListRow
            title="Sends you back to"
            trailing={
              <RowValue className="break-all">{client.returnHost}</RowValue>
            }
          />
        </List>
      </ListSection>
      {/* Two forms, as for a new API token: the one with the password holds
          the account and the password and nothing else. */}
      <form onSubmit={review}>
        <fieldset
          disabled={draft !== null}
          className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
        >
          {tokens.length > 0 ? (
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-2 px-1 text-[13px] font-semibold text-muted-foreground">
                Token
              </legend>
              <List>
                {tokens.map((token) => (
                  <ChoiceRow
                    key={token.id}
                    value={token.id}
                    checked={connectAs === token.id}
                    onChoose={() => setConnectAs(token.id)}
                    title={token.name}
                    description={
                      <>
                        The token it had (made{" "}
                        <LocalDate value={token.createdAt} />
                        ), with its levels and memories
                      </>
                    }
                  />
                ))}
                <ChoiceRow
                  value="new"
                  checked={connectAs === "new"}
                  onChoose={() => setConnectAs("new")}
                  title="A new token"
                />
              </List>
            </fieldset>
          ) : (
            <input type="hidden" name="connectAs" value="new" />
          )}
          {connectAs === "new" ? (
            <>
              <ListSection
                title="What it can reach"
                footer="Until you set a tool's level on the token's page, the assistant asks you before it runs it."
              >
                <Card>
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
                </Card>
              </ListSection>
              <Disclosure
                title="More options"
                description="Memories, web pages, running code, API endpoints, wrappers"
              >
                <ManageEndpointsField id="consent-manage" />
                <KeepMemoriesField id="consent-memories" />
                <WebFetchField id="consent-fetch" />
                <RunCodeField id="consent-code" />
                <ManageWrappersField id="consent-wrappers" />
              </Disclosure>
            </>
          ) : null}
          {draft === null ? (
            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="flex-1"
                disabled={denying || leaving}
                onClick={deny}
              >
                Deny
              </Button>
              <Button type="submit" size="lg" className="flex-1">
                Allow
              </Button>
            </div>
          ) : null}
          <FormError error={denyError} />
        </fieldset>
      </form>
      {draft !== null ? (
        <form action={action}>
          <Card>
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
            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="flex-1"
                disabled={leaving}
                onClick={() => setDraft(null)}
              >
                Back
              </Button>
              <SubmitButton
                size="lg"
                className="flex-1"
                pendingText="Checking…"
              >
                Confirm
              </SubmitButton>
            </div>
          </Card>
        </form>
      ) : null}
    </div>
  )
}

/** One radio in the list of tokens to connect as. */
function ChoiceRow({
  value,
  checked,
  onChoose,
  title,
  description,
}: {
  value: string
  checked: boolean
  onChoose: () => void
  title: React.ReactNode
  description?: React.ReactNode
}) {
  return (
    <label
      data-slot="list-row"
      className="flex min-h-14 cursor-pointer items-center gap-3.5 px-4 py-2.5 text-sm hover:bg-row-hover"
    >
      <input
        type="radio"
        name="connectAs"
        value={value}
        checked={checked}
        onChange={onChoose}
        className="size-4 shrink-0 cursor-pointer accent-primary"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] leading-snug text-foreground">
          {title}
        </span>
        {description ? (
          <span className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  )
}
