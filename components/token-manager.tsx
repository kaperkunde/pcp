"use client"

import Link from "next/link"
import { useActionState, useState, useTransition } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { ManageEndpointsField } from "@/components/manage-endpoints-field"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { SubmitButton } from "@/components/submit-button"
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
  endpointUrl,
}: {
  tokens: ApiTokenSummary[]
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  endpointUrl: string
}) {
  return (
    <div className="flex flex-col gap-6">
      <CreateTokenForm servers={servers} endpointUrl={endpointUrl} />
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
  endpointUrl,
}: {
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  endpointUrl: string
}) {
  const [state, action] = useActionState<CreateTokenResult, FormData>(
    createTokenAction,
    { status: "idle" },
  )
  if (state.status === "ok") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your new token</CardTitle>
          <CardDescription>
            Copy it now: PCP keeps only a hash and cannot show it again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyableValue value={state.token} testId="new-token" />
          <p className="text-muted-foreground">
            Point an MCP client at <code>{endpointUrl}</code> with the header{" "}
            <code>Authorization: Bearer &lt;token&gt;</code>. For Claude Code:
          </p>
          <CopyableValue
            value={`claude mcp add --transport http pcp ${endpointUrl} --header "Authorization: Bearer ${state.token}"`}
          />
          <form action={action}>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              formAction={() => window.location.reload()}
            >
              Done
            </Button>
          </form>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a token</CardTitle>
        <CardDescription>
          One per assistant or machine, so each can be revoked on its own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="token-name">
              <Input
                id="token-name"
                name="name"
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
          <Field
            label="Your password"
            htmlFor="token-password"
            hint="A token is a lasting way into your vault, so PCP asks for your password before it makes one."
          >
            <Input
              id="token-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton pendingText="Creating…">Create token</SubmitButton>
          </div>
        </form>
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
