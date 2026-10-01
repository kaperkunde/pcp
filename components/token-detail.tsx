"use client"

import { RefreshCw } from "lucide-react"
import {
  useActionState,
  useEffect,
  useOptimistic,
  useState,
  useTransition,
} from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { KeepMemoriesField } from "@/components/keep-memories-field"
import { ManageEndpointsField } from "@/components/manage-endpoints-field"
import { clearNewToken, peekNewToken } from "@/components/new-token-handoff"
import { PermissionDecision } from "@/components/permission-decision"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { refreshToolsAction } from "@/lib/actions/servers"
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
  copyTokenAccessAction,
  setServerToolAccessAction,
  setToolAccessAction,
  updateTokenAction,
  type UpdateTokenResult,
} from "@/lib/actions/tokens"
import type { ApiTokenSummary } from "@/lib/core/api-tokens"
import type { ServerKind } from "@/lib/core/servers"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  type PermissionDecision as Decision,
  type ToolAccess,
} from "@/lib/core/constants"
import type { TokenServerAccess, TokenToolAccess } from "@/lib/core/tool-access"
import type { ActionState } from "@/lib/server/action-state"
import { cn } from "@/lib/utils"

export type WaitingRequest = {
  id: string
  title: string
  lines: string[]
  warning: string | null
  decisions: Array<{ value: Decision; label: string }>
  /** A new server's secret, typed in when agreeing to it. */
  secret: {
    name: string
    exists: boolean
    optional: boolean
    clientId: string | null
  } | null
}

export function TokenDetail({
  token,
  servers,
  access,
  otherTokens,
  waiting,
  endpointUrl,
}: {
  token: ApiTokenSummary
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  access: TokenServerAccess[]
  otherTokens: Array<{ id: string; name: string }>
  waiting: WaitingRequest[]
  endpointUrl: string
}) {
  const locked = token.revokedAt !== null
  // Only right after the token list made it (new-token-handoff.ts).
  const [made, setMade] = useState(() => peekNewToken(token.id))

  useEffect(() => clearNewToken(token.id), [token.id])

  return (
    <div className="flex flex-col gap-6">
      {made ? (
        <NewTokenCard
          token={made}
          endpointUrl={endpointUrl}
          onDone={() => setMade(null)}
        />
      ) : null}
      {waiting.length > 0 ? <WaitingCard waiting={waiting} /> : null}
      {otherTokens.length > 0 && !locked ? (
        <CopyCard tokenId={token.id} otherTokens={otherTokens} />
      ) : null}
      <ToolsCard tokenId={token.id} access={access} locked={locked} />
      <SettingsCard token={token} servers={servers} locked={locked} />
    </div>
  )
}

function NewTokenCard({
  token,
  endpointUrl,
  onDone,
}: {
  token: string
  endpointUrl: string
  onDone: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your new token</CardTitle>
        <CardDescription>
          Copy it now: PCP keeps only a hash and cannot show it again. Then
          choose below what an assistant using it may run.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <CopyableValue value={token} testId="new-token" />
        <p className="text-muted-foreground">
          Point an MCP client at <code>{endpointUrl}</code> with the header{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>. For Claude Code:
        </p>
        <CopyableValue
          value={`claude mcp add --transport http pcp ${endpointUrl} --header "Authorization: Bearer ${token}"`}
        />
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onDone}>
            I have copied it
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function WaitingCard({ waiting }: { waiting: WaitingRequest[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting for you ({waiting.length})</CardTitle>
        <CardDescription>
          An assistant using this token asked for these. Nothing runs until you
          answer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {waiting.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 py-3">
              <span className="font-medium break-words">{item.title}</span>
              <ul className="flex list-disc flex-col gap-1 pl-5 break-words whitespace-pre-wrap text-muted-foreground">
                {item.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              {item.warning ? (
                <p
                  className="rounded-md border border-destructive/50 p-2"
                  role="note"
                >
                  {item.warning}
                </p>
              ) : null}
              <PermissionDecision
                id={item.id}
                decisions={item.decisions}
                secret={item.secret}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function ToolsCard({
  tokenId,
  access,
  locked,
}: {
  tokenId: string
  access: TokenServerAccess[]
  locked: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tools</CardTitle>
        <CardDescription>
          What an assistant using this token may run. Tools you have not decided
          about ask you the first time, and your answer there can decide them
          for good. Blocked tools are hidden from the assistant.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {access.length === 0 ? (
          <p className="text-muted-foreground">
            This token reaches no servers yet.
          </p>
        ) : (
          access.map((server) => (
            <ServerTools
              key={server.id}
              tokenId={tokenId}
              server={server}
              locked={locked}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function AccessOptions() {
  return TOOL_ACCESS_LEVELS.map((level) => (
    <option key={level} value={level}>
      {TOOL_ACCESS_LABELS[level]}
    </option>
  ))
}

function ServerTools({
  tokenId,
  server,
  locked,
}: {
  tokenId: string
  server: TokenServerAccess
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  const [bulk, setBulk] = useState<ToolAccess>("allowed")
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  function applyAll() {
    startTransition(async () => {
      const result = await setServerToolAccessAction(tokenId, server.id, bulk)
      setError(result.status === "error" ? result.error : null)
      setNote(null)
    })
  }

  // Servers add and drop tools as they please: read the list again so a new
  // one can be decided here before an assistant asks for it.
  function refresh() {
    startRefresh(async () => {
      const result = await refreshToolsAction(server.id)
      setError(result.status === "error" ? result.error : null)
      setNote(result.status === "ok" ? (result.message ?? null) : null)
    })
  }

  return (
    <section aria-label={server.name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{server.name}</span>
          <code className="text-xs text-muted-foreground">{server.slug}</code>
          {server.enabled ? null : (
            <Badge variant="outline">Switched off</Badge>
          )}
          {server.refreshable && !locked ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={refreshing}
              onClick={refresh}
              aria-label={`Refresh tools on ${server.slug}`}
              title="Read the server's tools again"
            >
              <RefreshCw
                className={cn("size-3.5", refreshing && "animate-spin")}
                aria-hidden
              />
            </Button>
          ) : null}
        </div>
        {server.tools.length > 0 && !locked ? (
          <div className="flex items-center gap-2">
            <Select
              aria-label={`All tools on ${server.slug}`}
              value={bulk}
              onChange={(event) => setBulk(event.target.value as ToolAccess)}
              className="h-8 w-auto"
            >
              <AccessOptions />
            </Select>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={pending}
              onClick={applyAll}
              aria-label={`Set all tools on ${server.slug}`}
            >
              {pending ? "Saving…" : "Set all"}
            </Button>
          </div>
        ) : null}
      </div>
      <FormError error={error} />
      <FormNote message={note} />
      {server.tools.length === 0 ? (
        <p className="text-muted-foreground">
          No tools known yet. Connect the server, or refresh its tools.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {server.tools.map((tool) => (
            <ToolAccessRow
              key={tool.name}
              tokenId={tokenId}
              serverId={server.id}
              slug={server.slug}
              tool={tool}
              locked={locked}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function ToolAccessRow({
  tokenId,
  serverId,
  slug,
  tool,
  locked,
}: {
  tokenId: string
  serverId: string
  slug: string
  tool: TokenToolAccess
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic(tool.access)
  const [error, setError] = useState<string | null>(null)

  function change(access: ToolAccess) {
    startTransition(async () => {
      setShown(access)
      const result = await setToolAccessAction(
        tokenId,
        serverId,
        tool.name,
        access,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="text-sm break-all">{tool.name}</code>
        {tool.title ? (
          <span className="text-xs text-muted-foreground">{tool.title}</span>
        ) : null}
      </div>
      <Select
        aria-label={`Access to ${slug}/${tool.name}`}
        value={shown}
        disabled={locked || pending}
        onChange={(event) => change(event.target.value as ToolAccess)}
        className={cn(
          "h-8 w-auto",
          shown === "blocked" && "text-destructive",
          shown === "allowed" && "text-primary",
        )}
      >
        <AccessOptions />
      </Select>
      <FormError error={error} className="basis-full" />
    </li>
  )
}

function CopyCard({
  tokenId,
  otherTokens,
}: {
  tokenId: string
  otherTokens: Array<{ id: string; name: string }>
}) {
  const [source, setSource] = useState(otherTokens[0]?.id ?? "")
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState>({ status: "idle" })

  function copy() {
    const name = otherTokens.find((token) => token.id === source)?.name ?? ""

    if (
      !window.confirm(
        `Replace this token's servers and tool access with those of "${name}"?`,
      )
    ) {
      return
    }

    startTransition(async () => {
      setResult(await copyTokenAccessAction(tokenId, source))
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Copy access</CardTitle>
        <CardDescription>
          Give this token the same servers and tool access as another one. What
          it has now is replaced.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Token to copy from"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="w-auto min-w-48"
          >
            {otherTokens.map((token) => (
              <option key={token.id} value={token.id}>
                {token.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || !source}
            onClick={copy}
          >
            {pending ? "Copying…" : "Copy access"}
          </Button>
        </div>
        <FormError error={result.status === "error" ? result.error : null} />
        <FormNote message={result.status === "ok" ? "Copied." : null} />
      </CardContent>
    </Card>
  )
}

function SettingsCard({
  token,
  servers,
  locked,
}: {
  token: ApiTokenSummary
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  locked: boolean
}) {
  const [state, action] = useActionState<UpdateTokenResult, FormData>(
    updateTokenAction,
    { status: "idle" },
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          {locked
            ? "This token is revoked; nothing about it can change."
            : "The token itself stays the same, so clients using it keep working."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action}>
          <fieldset disabled={locked} className="flex flex-col gap-4">
            <input type="hidden" name="id" value={token.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="token-name">
                <Input
                  id="token-name"
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={token.name}
                />
              </Field>
              <Field
                label="Expires"
                htmlFor="token-expires"
                hint={
                  <>
                    Now: <LocalDate value={token.expiresAt} />
                  </>
                }
              >
                <Select id="token-expires" name="expiresIn" defaultValue="keep">
                  <option value="keep">Keep as it is</option>
                  <option value="never">Never</option>
                  <option value="7">In 7 days</option>
                  <option value="30">In 30 days</option>
                  <option value="90">In 90 days</option>
                  <option value="365">In a year</option>
                </Select>
              </Field>
            </div>
            <ServerScopeFields
              servers={servers}
              allowAll={token.allowAllServers}
              selected={token.servers.map((server) => server.id)}
            />
            <ManageEndpointsField
              id="token-manage"
              defaultChecked={token.manageEndpoints}
            />
            <KeepMemoriesField
              id="token-memories"
              defaultChecked={token.keepMemories}
            />
            <FormError error={state.status === "error" ? state.error : null} />
            <FormNote message={state.status === "ok" ? state.message : null} />
            {locked ? null : (
              <div>
                <SubmitButton pendingText="Saving…">Save settings</SubmitButton>
              </div>
            )}
          </fieldset>
        </form>
      </CardContent>
    </Card>
  )
}
