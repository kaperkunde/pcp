"use client"

import { useActionState, useEffect, useState, useTransition } from "react"

import { CopyableValue } from "@/components/copyable-value"
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
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  deleteServerAction,
  disconnectOAuthAction,
  refreshToolsAction,
  setOAuthClientAction,
  setServerEnabledAction,
  setSignInParamsAction,
  setToolDescriptionAction,
  type ServerActionResult,
} from "@/lib/actions/servers"
import type { AuthType, ServerKind, ServerStatus } from "@/lib/core/servers"
import type { OAuthConnection } from "@/lib/core/upstream"

export type ServerDetailProps = {
  server: {
    id: string
    kind: ServerKind
    name: string
    slug: string
    url: string
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
    oauthConnection: OAuthConnection | null
    /** OAuth: what the sign-in adds to its address, as the owner set it. */
    oauthAuthorizeParams: string
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
  /** Where OAuth servers send you back: what a provider's client lists. */
  redirectUrl: string
}

export function ServerDetail({
  server,
  tools,
  notice,
  redirectUrl,
}: ServerDetailProps) {
  const endpoint = server.kind === "openapi"
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ServerActionResult>({ status: "idle" })
  // Kept here rather than in the form: saving moves the server on from
  // "needs a client", which removes the form, and the note should stay.
  const [clientState, saveClient] = useActionState<
    ServerActionResult,
    FormData
  >(setOAuthClientAction, { status: "idle" })

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
              />
              {endpoint && server.readOnly ? (
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
            {endpoint ? "Requests go to " : null}
            <code className="text-xs">{server.url}</code>
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
          {/* What the last visit to Connect said is out of date once you
              have given the server a client. */}
          {notice && clientState.status !== "ok" ? (
            notice.kind === "ok" ? (
              <FormNote message={notice.message} />
            ) : (
              <FormError error={notice.message} />
            )
          ) : null}
          {server.oauthConnection && !server.oauthConnection.renewable ? (
            <RenewalNotice
              server={server}
              connection={server.oauthConnection}
            />
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
          {server.authType === "oauth" &&
          server.status === "client_required" ? (
            <OAuthClientForm
              serverId={server.id}
              redirectUrl={redirectUrl}
              action={saveClient}
              error={clientState.status === "error" ? clientState.error : null}
            />
          ) : null}
          <FormNote
            message={clientState.status === "ok" ? clientState.message : null}
          />
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
              : "What an assistant can find with search_tools. Rewrite a description when the server's own wording would not help it choose."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tools.length === 0 ? (
            <p className="text-muted-foreground">
              {endpoint
                ? "No operations are offered yet. Re-read the schema, or replace it in the settings below."
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

/**
 * A sign-in PCP cannot renew: says until when it lasts, and what to do about
 * it. Signing in again fixes it when PCP knows what the provider needs
 * (Google); otherwise the server's documentation names the parameters, which
 * are asked for here and applied by signing in again.
 */
function RenewalNotice({
  server,
  connection,
}: {
  server: ServerDetailProps["server"]
  connection: OAuthConnection
}) {
  const start = `/api/servers/${server.id}/oauth/start`
  const [state, action] = useActionState<ServerActionResult, FormData>(
    setSignInParamsAction,
    { status: "idle" },
  )

  // Saved: sign in again, which is when the parameters apply. A full page
  // load, as the route redirects to the server's sign-in page.
  useEffect(() => {
    if (state.status === "ok") {
      window.location.assign(start)
    }
  }, [state, start])

  const lasts = connection.expiresAt ? (
    <>
      until <LocalDate value={connection.expiresAt} />
    </>
  ) : (
    "for a limited time"
  )

  if (connection.reconnectRenews) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-warning">
          This sign-in to {server.name} lasts {lasts}, and PCP cannot renew it.
          Sign in again to fix that: PCP now asks for access it can renew.
        </p>
        <a href={start} className={buttonVariants({ size: "sm" })}>
          Reconnect
        </a>
      </div>
    )
  }

  const prefix = `sign-in-params-${server.id}`

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="id" value={server.id} />
      <p className="text-warning">
        This sign-in to {server.name} lasts {lasts}, and PCP cannot renew it, so
        you would have to reconnect then. Many servers give renewable access
        only when the sign-in asks for it: enter what the server&apos;s
        documentation says, and sign in again.
      </p>
      <Field
        label="Extra sign-in parameters"
        htmlFor={`${prefix}-params`}
        hint="Added to the sign-in address, like access_type=offline&prompt=consent."
      >
        <Input
          id={`${prefix}-params`}
          name="oauthAuthorizeParams"
          defaultValue={server.oauthAuthorizeParams}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <FormError error={state.status === "error" ? state.error : null} />
      <div>
        <SubmitButton size="sm" pendingText="Saving…">
          Save and reconnect
        </SubmitButton>
      </div>
    </form>
  )
}

/**
 * The client a server that does not let PCP register itself needs, asked for
 * where its status says so. Scope and sign-in parameters stay in Settings.
 */
function OAuthClientForm({
  serverId,
  redirectUrl,
  action,
  error,
}: {
  serverId: string
  redirectUrl: string
  action: (formData: FormData) => void
  error: string | null
}) {
  const prefix = `oauth-client-${serverId}`

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="id" value={serverId} />
      <p className="text-muted-foreground">
        The redirect URI to give the provider:
      </p>
      <CopyableValue value={redirectUrl} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client ID" htmlFor={`${prefix}-id`}>
          <Input
            id={`${prefix}-id`}
            name="oauthClientId"
            required
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Client secret"
          htmlFor={`${prefix}-secret`}
          hint="Saved as one of your secrets."
        >
          <Input
            id={`${prefix}-secret`}
            name="oauthClientSecretValue"
            type="password"
            autoComplete="off"
          />
        </Field>
      </div>
      <FormError error={error} />
      <div>
        <SubmitButton size="sm" pendingText="Saving…">
          Save client
        </SubmitButton>
      </div>
    </form>
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
