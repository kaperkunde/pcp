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
import { Textarea } from "@/components/ui/input"
import {
  deleteServerAction,
  disconnectOAuthAction,
  refreshToolsAction,
  setServerEnabledAction,
  setToolDescriptionAction,
  type ServerActionResult,
} from "@/lib/actions/servers"
import type { AuthType, ServerStatus } from "@/lib/core/servers"

export type ServerDetailProps = {
  server: {
    id: string
    name: string
    slug: string
    url: string
    enabled: boolean
    authType: AuthType
    status: ServerStatus
    statusMessage: string
    connected: boolean
    lastSyncedAt: Date | null
  }
  tools: Array<{
    name: string
    title: string | null
    description: string
    descriptionOverride: string | null
  }>
  notice: { kind: "ok" | "error"; message: string } | null
}

export function ServerDetail({ server, tools, notice }: ServerDetailProps) {
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
              />
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
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => run(() => refreshToolsAction(server.id))}
              >
                {pending ? "Checking…" : "Refresh tools"}
              </Button>
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
            <code className="text-xs">{server.url}</code> · last checked{" "}
            <LocalDate value={server.lastSyncedAt} />
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
            What an assistant can find with search_tools. Rewrite a description
            when the server&apos;s own wording would not help it choose.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tools.length === 0 ? (
            <p className="text-muted-foreground">
              No tools known yet. Connect the server, or refresh its tools.
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
            Deletes the server, its tool list and any OAuth tokens PCP holds for
            it. Secrets you added stay.
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
            Leave it empty to go back to the server&apos;s own description.
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
