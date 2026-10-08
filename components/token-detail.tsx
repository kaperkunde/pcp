"use client"

import { ChevronRight, RefreshCw } from "lucide-react"
import {
  useActionState,
  useEffect,
  useId,
  useOptimistic,
  useState,
  useTransition,
} from "react"

import { AllTokensCheckbox } from "@/components/all-tokens-checkbox"
import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { KeepMemoriesField } from "@/components/keep-memories-field"
import { ManageEndpointsField } from "@/components/manage-endpoints-field"
import { clearNewToken, peekNewToken } from "@/components/new-token-handoff"
import { PermissionDecision } from "@/components/permission-decision"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { ShownInFull } from "@/components/shown-in-full"
import { SubmitButton } from "@/components/submit-button"
import { WebFetchCard } from "@/components/web-fetch-card"
import { ManageWrappersField } from "@/components/manage-wrappers-field"
import { RunCodeField } from "@/components/run-code-field"
import { WebFetchField } from "@/components/web-fetch-field"
import { Badge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
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
  endAllowanceAction,
  setServerToolAccessAction,
  setToolAccessAction,
  setToolAccessSharedAction,
  updateTokenAction,
  type UpdateTokenResult,
} from "@/lib/actions/tokens"
import type { ApiTokenSummary } from "@/lib/core/api-tokens"
import type { ShownText } from "@/lib/core/permission-rules"
import type { ServerKind } from "@/lib/core/servers"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  type PermissionDecision as Decision,
  type ToolAccess,
} from "@/lib/core/constants"
import type { TokenServerAccess, TokenToolAccess } from "@/lib/core/tool-access"
import type { TokenFetchRules } from "@/lib/core/web-fetch"
import type { ActionState } from "@/lib/server/action-state"
import { cn } from "@/lib/utils"

export type WaitingRequest = {
  id: string
  /** Proposed tool levels are reviewed and saved on their own page. */
  review: boolean
  title: string
  lines: string[]
  /** Everything it carries, when the lines cut it short. */
  full: ShownText[] | null
  warning: string | null
  decisions: Array<{ value: Decision; label: string }>
  /** A new server's secret, typed in when agreeing to it. */
  secret: {
    name: string
    exists: boolean
    optional: boolean
    clientId: string | null
  } | null
  /** A memory to share: the toggle for reading it in every conversation. */
  every: { asked: boolean } | null
}

/** A tool or a site allowed for a while, as the page is handed it. */
export type AllowanceItem =
  | {
      kind: "tool"
      serverId: string
      serverName: string
      toolName: string
      until: string
    }
  | { kind: "site"; host: string; until: string }

export function TokenDetail({
  token,
  servers,
  access,
  allowances = [],
  otherTokens,
  waiting,
  endpointUrl,
  fetchRules,
  browser = false,
}: {
  token: ApiTokenSummary
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  access: TokenServerAccess[]
  /** What the owner allowed it for a while, from "Allow for" on a request. */
  allowances?: AllowanceItem[]
  otherTokens: Array<{ id: string; name: string }>
  waiting: WaitingRequest[]
  endpointUrl: string
  /** Only for a token that may fetch web pages, or reaches the browser. */
  fetchRules: TokenFetchRules | null
  /** The token reaches the browser, which follows the same sites. */
  browser?: boolean
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
      {allowances.length > 0 ? (
        <AllowancesCard tokenId={token.id} allowances={allowances} />
      ) : null}
      {otherTokens.length > 0 && !locked ? (
        <CopyCard tokenId={token.id} otherTokens={otherTokens} />
      ) : null}
      <ToolsCard tokenId={token.id} access={access} locked={locked} />
      {(token.webFetch || browser) && fetchRules ? (
        <WebFetchCard
          tokenId={token.id}
          rules={fetchRules}
          locked={locked}
          webFetch={token.webFetch}
          browser={browser}
        />
      ) : null}
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
              {item.full ? <ShownInFull parts={item.full} /> : null}
              {item.warning ? (
                <p
                  className="rounded-md border border-destructive/50 p-2"
                  role="note"
                >
                  {item.warning}
                </p>
              ) : null}
              {item.review ? (
                <div>
                  <ButtonLink href={`/permissions/${item.id}`} size="sm">
                    Review and save
                  </ButtonLink>
                </div>
              ) : (
                <PermissionDecision
                  id={item.id}
                  decisions={item.decisions}
                  secret={item.secret}
                  every={item.every}
                />
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function AllowancesCard({
  tokenId,
  allowances,
}: {
  tokenId: string
  allowances: AllowanceItem[]
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState>({ status: "idle" })

  function end(allowance: AllowanceItem) {
    startTransition(async () => {
      setResult(
        await endAllowanceAction(
          tokenId,
          allowance.kind === "site"
            ? { kind: "site", host: allowance.host }
            : {
                kind: "tool",
                serverId: allowance.serverId,
                toolName: allowance.toolName,
              },
        ),
      )
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allowed for now</CardTitle>
        <CardDescription>
          What you allowed for a while when an assistant using this token asked.
          Until then it goes ahead without asking you; afterwards the settings
          below decide again. A blocked tool or site stays blocked.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ul className="flex flex-col divide-y divide-border">
          {allowances.map((allowance) => (
            <li
              key={
                allowance.kind === "site"
                  ? `site:${allowance.host}`
                  : `tool:${allowance.serverId}/${allowance.toolName}`
              }
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-medium break-words">
                  {allowance.kind === "site"
                    ? allowance.host
                    : `${allowance.serverName} · ${allowance.toolName}`}
                </span>
                <span className="text-muted-foreground">
                  {allowance.kind === "site" ? "Site" : "Tool"}, until{" "}
                  <LocalDate value={allowance.until} />
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => end(allowance)}
              >
                End now
              </Button>
            </li>
          ))}
        </ul>
        <FormError error={result.status === "error" ? result.error : null} />
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

/** "12 tools: 3 allowed, 9 ask you first", for a server shown folded. */
function toolsSummary(tools: TokenToolAccess[]): string {
  const counts = TOOL_ACCESS_LEVELS.map(
    (level) =>
      [level, tools.filter((tool) => tool.access === level).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(
      ([level, count]) => `${count} ${TOOL_ACCESS_LABELS[level].toLowerCase()}`,
    )

  return `${tools.length} ${tools.length === 1 ? "tool" : "tools"}: ${counts.join(", ")}`
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
  // Folded until asked for: a server can bring hundreds of tools, and the
  // page should show every server at a glance.
  const [open, setOpen] = useState(false)
  const listId = useId()

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
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
            className="-ml-1 flex cursor-pointer flex-wrap items-center gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
              aria-hidden
            />
            <span className="font-medium">{server.name}</span>
            <code className="text-xs text-muted-foreground">{server.slug}</code>
          </button>
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
        <p id={listId} className="pl-6 text-muted-foreground">
          No tools known yet. Connect the server, or refresh its tools.
        </p>
      ) : !open ? (
        <p id={listId} className="pl-6 text-muted-foreground">
          {toolsSummary(server.tools)}
        </p>
      ) : (
        <ul id={listId} className="flex flex-col divide-y divide-border pl-6">
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
  const [shown, setShown] = useOptimistic({
    access: tool.access,
    shared: tool.own === null && tool.shared !== null,
  })
  const [error, setError] = useState<string | null>(null)

  // A change here is this token's own level, which wins over all tokens'.
  function change(access: ToolAccess) {
    startTransition(async () => {
      setShown({ access, shared: false })
      const result = await setToolAccessAction(
        tokenId,
        serverId,
        tool.name,
        access,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  function share(shared: boolean) {
    startTransition(async () => {
      setShown({ ...shown, shared })
      const result = await setToolAccessSharedAction(
        tokenId,
        serverId,
        tool.name,
        shared,
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
      <div className="flex flex-wrap items-center gap-3">
        <AllTokensCheckbox
          checked={shown.shared}
          disabled={locked || pending}
          label={`All tokens for ${slug}/${tool.name}`}
          sharedLevel={tool.shared ? TOOL_ACCESS_LABELS[tool.shared] : null}
          onChange={share}
        />
        <Select
          aria-label={`Access to ${slug}/${tool.name}`}
          value={shown.access}
          disabled={locked || pending}
          onChange={(event) => change(event.target.value as ToolAccess)}
          className={cn(
            "h-8 w-auto",
            shown.access === "blocked" && "text-destructive",
            shown.access === "allowed" && "text-primary",
          )}
        >
          <AccessOptions />
        </Select>
      </div>
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
        `Replace this token's servers, tool access and web fetch settings with those of "${name}"?`,
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
          Give this token the same servers, tool access and web fetch settings
          as another one. What it has now is replaced; settings for all tokens
          stay as they are.
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
            : token.oauthClient
              ? `${token.oauthClient.name} stays signed in with it.`
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
            <WebFetchField id="token-fetch" defaultChecked={token.webFetch} />
            <RunCodeField id="token-code" defaultChecked={token.runCode} />
            <ManageWrappersField
              id="token-wrappers"
              defaultChecked={token.manageWrappers}
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
