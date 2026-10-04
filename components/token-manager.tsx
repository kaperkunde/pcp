"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  useActionState,
  useEffect,
  useState,
  useTransition,
  type FormEvent,
} from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { KeepMemoriesField } from "@/components/keep-memories-field"
import { ManageEndpointsField } from "@/components/manage-endpoints-field"
import { handOffNewToken } from "@/components/new-token-handoff"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { SubmitButton } from "@/components/submit-button"
import { WebFetchField } from "@/components/web-fetch-field"
import { Badge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { UsernameField } from "@/components/username-field"
import {
  createTokenAction,
  deleteTokenAction,
  revokeTokenAction,
  type CreateTokenResult,
} from "@/lib/actions/tokens"
import type { ApiTokenSummary } from "@/lib/core/api-tokens"
import type { ServerKind } from "@/lib/core/servers"

export function TokenManager({
  tokens,
  servers,
  username,
}: {
  tokens: ApiTokenSummary[]
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  username: string
}) {
  return (
    <div className="flex flex-col gap-6">
      <CreateTokenForm servers={servers} username={username} />
      <Card>
        <CardHeader>
          <CardTitle>Tokens ({tokens.length})</CardTitle>
          <CardDescription>
            Revoking a token destroys its copy of the vault key; nothing that
            token could reach can be read with it again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="text-muted-foreground">No tokens yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {tokens.map((token) => (
                <TokenRow key={token.id} token={token} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CreateTokenForm({
  servers,
  username,
}: {
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  username: string
}) {
  const [state, action] = useActionState<CreateTokenResult, FormData>(
    createTokenAction,
    { status: "idle" },
  )
  const router = useRouter()
  const made = state.status === "ok" ? state : null

  // A new token can do nothing yet without asking: open its page, where the
  // owner copies it once and decides what it may run.
  useEffect(() => {
    if (made) {
      handOffNewToken(made.id, made.token)
      router.push(`/tokens/${made.id}`)
    }
  }, [made, router])

  // What the first form chose, while the second asks for the password.
  const [draft, setDraft] = useState<Array<[string, string]> | null>(null)

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const entries: Array<[string, string]> = []

    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string") entries.push([key, value])
    }

    setDraft(entries)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a token</CardTitle>
        <CardDescription>
          One per assistant or machine, so each can be revoked on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Two forms, so the one with the password holds the account and the
            password and nothing else: next to a name field and a "Create"
            button, Safari takes a password field for a sign-up and offers
            to generate one, whatever its autocomplete says. */}
        <form onSubmit={review}>
          <fieldset disabled={draft !== null} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="token-name">
                <Input
                  id="token-name"
                  name="name"
                  autoComplete="off"
                  required
                  maxLength={80}
                  placeholder="Claude on my laptop"
                />
              </Field>
              <Field label="Expires" htmlFor="token-expires">
                <Select id="token-expires" name="expiresIn" defaultValue="">
                  <option value="">Never</option>
                  <option value="7">In 7 days</option>
                  <option value="30">In 30 days</option>
                  <option value="90">In 90 days</option>
                  <option value="365">In a year</option>
                </Select>
              </Field>
            </div>
            <ServerScopeFields servers={servers} />
            <ManageEndpointsField id="token-manage" />
            <KeepMemoriesField id="token-memories" />
            <WebFetchField id="token-fetch" />
            {draft === null ? (
              <div>
                <Button type="submit">Create token</Button>
              </div>
            ) : null}
          </fieldset>
        </form>
        {draft !== null ? (
          <form
            action={action}
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
          >
            <p className="text-muted-foreground">
              A token is a lasting way into your vault, so PCP asks for your
              password before it makes one.
            </p>
            {draft.map(([key, value], index) => (
              <input key={index} type="hidden" name={key} value={value} />
            ))}
            <UsernameField id="token-account" value={username} />
            <Field label="Your password" htmlFor="token-password">
              <Input
                id="token-password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
              />
            </Field>
            <FormError error={state.status === "error" ? state.error : null} />
            <FormNote message={made ? "Created. Opening it…" : null} />
            <div className="flex gap-2">
              <SubmitButton pendingText="Checking…">Confirm</SubmitButton>
              <Button
                type="button"
                variant="outline"
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

function TokenRow({ token }: { token: ApiTokenSummary }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const expired =
    token.expiresAt !== null && token.expiresAt.getTime() < Date.now()
  const dead = token.revokedAt !== null || expired

  function revoke() {
    if (
      !window.confirm(
        `Revoke "${token.name}"? Clients using it stop working at once.`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const result = await revokeTokenAction(token.id)
      if (result.status === "error") setError(result.error)
    })
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteTokenAction(token.id)
      if (result.status === "error") setError(result.error)
    })
  }

  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/tokens/${token.id}`}
            className="font-medium hover:underline"
          >
            {token.name}
          </Link>
          <code className="text-xs text-muted-foreground">{token.prefix}…</code>
          {token.revokedAt ? (
            <Badge variant="destructive">Revoked</Badge>
          ) : expired ? (
            <Badge variant="destructive">Expired</Badge>
          ) : token.allowAllServers ? (
            <Badge>All servers</Badge>
          ) : (
            token.servers.map((server) => (
              <Badge key={server.id} variant="outline">
                {server.name}
              </Badge>
            ))
          )}
          {!dead && token.manageEndpoints ? (
            <Badge variant="warning">Manages endpoints</Badge>
          ) : null}
          {!dead && token.keepMemories ? (
            <Badge variant="outline">Keeps memories</Badge>
          ) : null}
          {!dead && token.webFetch ? (
            <Badge variant="outline">Fetches the web</Badge>
          ) : null}
          {!dead && token.openPermissions > 0 ? (
            <Badge variant="warning">{token.openPermissions} waiting</Badge>
          ) : null}
        </div>
        <div className="flex gap-1">
          <ButtonLink href={`/tokens/${token.id}`} variant="ghost" size="xs">
            {dead ? "Details" : "Edit access"}
          </ButtonLink>
          {dead ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={pending}
              onClick={remove}
            >
              Delete
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              disabled={pending}
              onClick={revoke}
            >
              Revoke
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Created <LocalDate value={token.createdAt} /> · last used{" "}
        <LocalDate value={token.lastUsedAt} />
        {token.expiresAt ? (
          <>
            {" "}
            · expires <LocalDate value={token.expiresAt} />
          </>
        ) : null}
      </p>
      <FormError error={error} />
    </li>
  )
}
