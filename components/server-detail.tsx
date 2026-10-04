"use client"

import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { ServerStatusBadge } from "@/components/server-status-badge"
import { SubmitButton } from "@/components/submit-button"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/input"
import {
  deleteServerAction,
  disconnectOAuthAction,
  refreshToolsAction,
  setServerEnabledAction,
  setToolDescriptionAction,
  type ServerActionResult,
} from "@/lib/actions/servers"
import type { AuthType, ServerKind, ServerStatus } from "@/lib/core/servers"

export type ServerDetailProps = {
  server: {
    id: string
    kind: ServerKind
    name: string
    slug: string
    url: string
    /** imap: where mail is sent; null when the account cannot send. */
    smtpUrl?: string | null
    enabled: boolean
    readOnly: boolean
    publicOnly: boolean
    specSource: "url" | "upload" | null
    specUrl: string | null
    authType: AuthType
    status: ServerStatus
    statusMessage: string
    connected: boolean
    lastSyncedAt: Date | null
    /** OAuth: whether PCP can renew its access, and until when it lasts. */
    oauthConnection: { renewable: boolean; expiresAt: Date | null } | null
  }
  tools: Array<{
    name: string
    title: string | null
    description: string
    descriptionOverride: string | null
    /** An API endpoint's tool: the request it makes. */
    operation: { method: string; path: string } | null
  }>
  notice: { kind: "ok" | "error"; message: string } | null
}

export function ServerDetail({ server, tools, notice }: ServerDetailProps) {
  const endpoint = server.kind === "openapi"
  const mail = server.kind === "jmap" || server.kind === "imap"
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ServerActionResult>({ status: "idle" })

  function run(action: () => Promise<ServerActionResult>) {
    startTransition(async () => {
      setResult(await action())
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <CardTitle>Status</CardTitle>
              <ServerStatusBadge
                status={server.status}
                connected={server.connected}
                enabled={server.enabled}
                kind={server.kind}
                oauth={server.authType === "oauth"}
              />
              {(endpoint || mail) && server.readOnly ? (
                <Badge variant="outline">Read-only</Badge>
              ) : null}
              {endpoint && server.publicOnly ? (
                <Badge variant="outline">Public addresses only</Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {server.authType === "oauth" ? (
                <>
                  {/* A plain anchor, not next/link: the route redirects to
                      the server's sign-in page, which must be a full page
                      load. */}
                  <a
                    href={`/api/servers/${server.id}/oauth/start`}
                    className={buttonVariants({ size: "sm" })}
                  >
                    {server.connected ? "Reconnect" : "Connect"}
                  </a>
                  {server.connected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        run(() => disconnectOAuthAction(server.id))
                      }
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </>
              ) : null}
              {/* An uploaded schema has nothing to download again; replace
                  it in the settings below. */}
              {!endpoint || server.specSource === "url" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => refreshToolsAction(server.id))}
                >
                  {pending
                    ? endpoint
                      ? "Reading…"
                      : "Checking…"
                    : endpoint
                      ? "Re-read schema"
                      : mail
                        ? "Check account"
                        : "Refresh tools"}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() => setServerEnabledAction(server.id, !server.enabled))
                }
              >
                {server.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          </div>
          <CardDescription>
            {endpoint ? "Requests go to " : mail ? "Signs in at " : null}
            <code className="text-xs">{server.url}</code>
            {mail && server.smtpUrl ? (
              <>
                {" "}
                · sends through{" "}
                <code className="text-xs">{server.smtpUrl}</code>
              </>
            ) : null}
            {endpoint ? (
              <>
                {" "}
                · schema{" "}
                {server.specSource === "url" && server.specUrl ? (
                  <>
                    from <code className="text-xs">{server.specUrl}</code>
                  </>
                ) : (
                  "uploaded"
                )}{" "}
                · read <LocalDate value={server.lastSyncedAt} />
              </>
            ) : (
              <>
                {" "}
                · last checked <LocalDate value={server.lastSyncedAt} />
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notice ? (
            notice.kind === "ok" ? (
              <FormNote message={notice.message} />
            ) : (
              <FormError error={notice.message} />
            )
          ) : null}
          {server.oauthConnection && !server.oauthConnection.renewable ? (
            <p className="text-warning">
              {server.name} did not give PCP a way to renew its access, so you
              will need to reconnect when it runs out
              {server.oauthConnection.expiresAt ? (
                <>
                  {" "}
                  (<LocalDate value={server.oauthConnection.expiresAt} />)
                </>
              ) : null}
              . Some servers only do that when the sign-in asks for it: see
              Extra sign-in parameters under Settings.
            </p>
          ) : null}
          {server.statusMessage ? (
            <p
              className={
                server.status === "ok"
                  ? "text-muted-foreground"
                  : "text-warning"
              }
            >
              {server.statusMessage}
            </p>
          ) : null}
          <FormError error={result.status === "error" ? result.error : null} />
          <FormNote message={result.status === "ok" ? result.message : null} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools ({tools.length})</CardTitle>
          <CardDescription>
            {endpoint
              ? "What an assistant can find with search_tools. Each one is an operation from the schema; rewrite a description when the schema's wording would not help it choose."
              : mail
                ? "What an assistant can find with search_tools: the same mail tools for every account, less those a read-only account or one that cannot send leaves out."
                : "What an assistant can find with search_tools. Rewrite a description when the server's own wording would not help it choose."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tools.length === 0 ? (
            <p className="text-muted-foreground">
              {endpoint
                ? "No operations are offered yet. Re-read the schema, or replace it in the settings below."
                : mail
                  ? "No tools yet: PCP offers them once it has signed in. Check the settings below, then check the account again, or connect it."
                  : "No tools known yet. Connect the server, or refresh its tools."}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {tools.map((tool) => (
                <ToolRow key={tool.name} serverId={server.id} tool={tool} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Remove</CardTitle>
          <CardDescription>
            {endpoint
              ? "Deletes the endpoint, its tool list and PCP's copy of its schema. Secrets you added stay."
              : mail
                ? "Takes the account out of PCP, with its tool list and any OAuth tokens PCP holds for it. Your mail stays on the server, and secrets you added stay."
                : "Deletes the server, its tool list and any OAuth tokens PCP holds for it. Secrets you added stay."}
          </CardDescription>
        </CardHeader>
        <CardContent className="items-start">
          <form
            action={() => deleteServerAction(server.id)}
            onSubmit={(event) => {
              if (!window.confirm(`Remove ${server.name} from PCP?`)) {
                event.preventDefault()
              }
            }}
          >
            <SubmitButton variant="destructive" pendingText="Removing…">
              Remove {server.name}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function ToolRow({
  serverId,
  tool,
}: {
  serverId: string
  tool: ServerDetailProps["tools"][number]
}) {
  const [editing, setEditing] = useState(false)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    setToolDescriptionAction,
    { status: "idle" },
  )

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <code className="text-sm">{tool.name}</code>
          {tool.title ? (
            <span className="text-xs text-muted-foreground">{tool.title}</span>
          ) : null}
          {tool.operation ? (
            <code className="text-xs text-muted-foreground">
              {tool.operation.method} {tool.operation.path}
            </code>
          ) : null}
          {tool.descriptionOverride ? (
            <span className="text-xs text-primary">edited</span>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? "Cancel" : "Edit description"}
        </Button>
      </div>
      {editing ? (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="serverId" value={serverId} />
          <input type="hidden" name="tool" value={tool.name} />
          <Textarea
            name="description"
            defaultValue={tool.descriptionOverride ?? tool.description}
            aria-label={`Description of ${tool.name}`}
            maxLength={2000}
          />
          <p className="text-xs text-muted-foreground">
            Leave it empty to go back to the original description.
          </p>
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton size="sm" pendingText="Saving…">
              Save description
            </SubmitButton>
          </div>
        </form>
      ) : (
        <p className="whitespace-pre-line text-muted-foreground">
          {tool.descriptionOverride ?? tool.description ?? ""}
        </p>
      )}
    </li>
  )
}
