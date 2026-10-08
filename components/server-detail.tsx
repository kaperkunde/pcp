"use client"

import {
  useActionState,
  useEffect,
  useId,
  useOptimistic,
  useState,
  useTransition,
  type ReactNode,
} from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate, RelativeDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { ServerStatusBadge } from "@/components/server-status-badge"
import { ServerTools, type ServerTool } from "@/components/server-tools"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Disclosure } from "@/components/ui/disclosure"
import { IconTile, serverKindLabel } from "@/components/ui/icon-tile"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import {
  deleteServerAction,
  disconnectOAuthAction,
  refreshToolsAction,
  setOAuthClientAction,
  setServerEnabledAction,
  setSignInParamsAction,
  type ServerActionResult,
} from "@/lib/actions/servers"
import type { AuthType, ServerKind, ServerStatus } from "@/lib/core/servers"
import type { OAuthConnection } from "@/lib/core/upstream"
import { cn } from "@/lib/utils"

export type ServerDetailProps = {
  server: {
    id: string
    kind: ServerKind
    name: string
    slug: string
    description: string
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
    oauthConnection: OAuthConnection | null
    /** OAuth: what the sign-in adds to its address, as the owner set it. */
    oauthAuthorizeParams: string
  }
  tools: ServerTool[]
  notice: { kind: "ok" | "error"; message: string } | null
  /** Where OAuth servers send you back: what a provider's client lists. */
  redirectUrl: string
  /** The kind's settings form, folded under Advanced. */
  settings: ReactNode
  /** What the kind needs from you, shown after About (SSH's keys). */
  children?: ReactNode
}

/**
 * One server's page: its state and main action at the top, what needs the
 * owner right under it, then About (description, sign-in, on/off), the
 * kind's own section, its tools, everything set once under Advanced, and
 * Remove last. DESIGN.md › What goes where.
 */
export function ServerDetail({
  server,
  tools,
  notice,
  redirectUrl,
  settings,
  children,
}: ServerDetailProps) {
  const endpoint = server.kind === "openapi"
  const mail = server.kind === "jmap" || server.kind === "imap"
  const browser = server.kind === "browser"
  const wrapper = server.kind === "wrapper"
  const ssh = server.kind === "ssh"
  const oauth = server.authType === "oauth"
  const advancedId = useId()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ServerActionResult>({ status: "idle" })
  const [enabled, setEnabled] = useOptimistic(server.enabled)
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

  /** Unfolds Advanced, and puts the cursor in one of its fields. */
  function openAdvanced(field?: string) {
    const details = document.getElementById(advancedId)
    if (!(details instanceof HTMLDetailsElement)) return
    details.open = true
    const target = field
      ? details.querySelector<HTMLElement>(`[name="${field}"]`)
      : null
    ;(target ?? details).scrollIntoView({ behavior: "smooth", block: "center" })
    target?.focus({ preventScroll: true })
  }

  // An uploaded schema has nothing to download again; it is replaced
  // under Advanced.
  const canRefresh = !wrapper && (!endpoint || server.specSource === "url")
  const refreshLabel = endpoint
    ? "Re-read schema"
    : mail
      ? "Check account"
      : ssh
        ? "Check sign-in"
        : browser
          ? "Check browser"
          : "Refresh tools"
  const statusTrouble = server.statusMessage && server.status !== "ok"

  return (
    <>
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind={server.kind} size="lg" />}
        title={server.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ServerStatusBadge
              status={server.status}
              connected={server.connected}
              enabled={server.enabled}
              kind={server.kind}
              oauth={oauth}
              className="text-sm"
            />
            <span aria-hidden>·</span>
            <span>{serverKindLabel(server.kind)}</span>
            <span aria-hidden>·</span>
            <span>
              {tools.length} {tools.length === 1 ? "tool" : "tools"}
            </span>
            {(endpoint || mail) && server.readOnly ? (
              <Badge variant="secondary">Read-only</Badge>
            ) : null}
          </span>
        }
        action={
          <>
            {canRefresh ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => refreshToolsAction(server.id))}
              >
                {pending ? (endpoint ? "Reading…" : "Checking…") : refreshLabel}
              </Button>
            ) : null}
            {wrapper ? (
              <Button variant="secondary" onClick={() => openAdvanced()}>
                Edit
              </Button>
            ) : null}
            {oauth ? (
              // A plain anchor, not next/link: the route redirects to the
              // server's sign-in page, which must be a full page load.
              <a
                href={`/api/servers/${server.id}/oauth/start`}
                className={buttonVariants({
                  variant: server.connected ? "secondary" : "default",
                })}
              >
                {server.connected ? "Reconnect" : "Connect"}
              </a>
            ) : null}
          </>
        }
      />

      {/* What the last visit to Connect said is out of date once you have
          given the server a client. */}
      {notice && clientState.status !== "ok" ? (
        notice.kind === "ok" ? (
          <FormNote
            message={notice.message}
            className="rounded-xl bg-card px-4 py-3 text-foreground"
          />
        ) : (
          <FormError
            error={notice.message}
            className="rounded-xl bg-card px-4 py-3"
          />
        )
      ) : null}
      {result.status !== "idle" || clientState.status === "ok" ? (
        <div className="-mt-4 flex flex-col gap-1 px-1 empty:hidden">
          <FormNote
            message={clientState.status === "ok" ? clientState.message : null}
          />
          <FormError error={result.status === "error" ? result.error : null} />
          <FormNote message={result.status === "ok" ? result.message : null} />
        </div>
      ) : null}
      {statusTrouble ? (
        <Attention>
          <p>{server.statusMessage}</p>
        </Attention>
      ) : null}
      {server.oauthConnection && !server.oauthConnection.renewable ? (
        <RenewalNotice server={server} connection={server.oauthConnection} />
      ) : null}
      {oauth && server.status === "client_required" ? (
        <OAuthClientForm
          serverId={server.id}
          redirectUrl={redirectUrl}
          action={saveClient}
          error={clientState.status === "error" ? clientState.error : null}
        />
      ) : null}

      <ListSection title="About">
        <List>
          <div className="flex min-h-14 flex-wrap items-start gap-x-3.5 gap-y-2 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Description</span>
              <p
                className={cn(
                  "text-[15px] leading-snug whitespace-pre-line",
                  !server.description && "text-muted-foreground",
                )}
              >
                {server.description || "No description yet."}
              </p>
              <span className="text-xs leading-relaxed text-muted-foreground">
                Assistants read this when they look for a tool. Write it in your
                words.
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openAdvanced("description")}
            >
              Edit
            </Button>
          </div>
          <SignInRow
            server={server}
            pending={pending}
            onDisconnect={() => run(() => disconnectOAuthAction(server.id))}
          />
          <ListRow
            title={
              endpoint ? (
                <>
                  Schema read <RelativeDate value={server.lastSyncedAt} />
                </>
              ) : wrapper ? (
                <>
                  Changed <RelativeDate value={server.lastSyncedAt} />
                </>
              ) : (
                <>
                  Last checked <RelativeDate value={server.lastSyncedAt} />
                </>
              )
            }
            description={
              server.status === "ok" && server.statusMessage
                ? server.statusMessage
                : null
            }
          />
          <SwitchRow
            id={`server-enabled-${server.id}`}
            label="On"
            description="Off hides every tool from every assistant."
            checked={enabled}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.checked
              startTransition(async () => {
                setEnabled(next)
                setResult(await setServerEnabledAction(server.id, next))
              })
            }}
          />
        </List>
      </ListSection>

      {children}

      {browser ? (
        <ListSection title="Tabs and sign-ins">
          <List>
            <ListRow
              href="/browser"
              title="Browser page"
              description="Its tabs, live, the sign-ins it keeps, and Chromium on this machine. Which sites each token may open is on the token's page, with web fetch."
            />
          </List>
        </ListSection>
      ) : null}

      <ServerTools serverId={server.id} kind={server.kind} tools={tools} />

      <Disclosure
        id={advancedId}
        title="Advanced"
        description={advancedSummary(server.kind)}
      >
        {endpoint ? <EndpointFacts server={server} /> : null}
        {settings}
      </Disclosure>

      <RemoveServer server={server} />
    </>
  )
}

function advancedSummary(kind: ServerKind): string {
  switch (kind) {
    case "openapi":
      return "Schema, base URL, sign-in, edits to the schema, public addresses, name"
    case "jmap":
    case "imap":
      return "Addresses, sign-in, sender, read-only, name"
    case "ssh":
      return "Host, port, login, name"
    case "wrapper":
      return "The whole definition as JSON, short name, name"
    case "browser":
      return "Name and description"
    default:
      return "Address, sign-in, headers, sign-in app, short name"
  }
}

/** A box for what needs the owner now: amber, at the top. */
function Attention({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 text-sm leading-relaxed text-warning ring-1 ring-warning/30">
      {children}
    </div>
  )
}

/** How PCP signs in, and, with OAuth, whether it is signed in. */
function SignInRow({
  server,
  pending,
  onDisconnect,
}: {
  server: ServerDetailProps["server"]
  pending: boolean
  onDisconnect: () => void
}) {
  if (
    server.kind === "browser" ||
    server.kind === "wrapper" ||
    server.kind === "ssh"
  ) {
    return null
  }

  if (server.authType === "oauth") {
    const connection = server.oauthConnection

    return (
      <ListRow
        title="Sign-in"
        description={
          !server.connected ? (
            "With OAuth, not signed in yet: Connect opens the server's sign-in."
          ) : connection?.renewable ? (
            "Signed in with OAuth. PCP renews its access on its own."
          ) : connection?.expiresAt ? (
            <>
              Signed in with OAuth, until{" "}
              <LocalDate value={connection.expiresAt} />.
            </>
          ) : (
            "Signed in with OAuth."
          )
        }
        trailing={
          server.connected ? (
            <Button
              variant="plain"
              size="sm"
              disabled={pending}
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          ) : null
        }
      />
    )
  }

  return (
    <ListRow
      title="Sign-in"
      trailing={
        <RowValue>
          {server.authType === "header"
            ? "A secret in a header"
            : server.authType === "basic"
              ? "User name and password"
              : "None"}
        </RowValue>
      }
    />
  )
}

/**
 * An endpoint's facts its form does not show as they are: where requests
 * go (the form's base URL is left empty, for the owner to type), where the
 * schema came from and when it was read, and which addresses it may reach.
 * Every other kind's form shows its own settings whole.
 */
function EndpointFacts({ server }: { server: ServerDetailProps["server"] }) {
  const code = (value: string) => (
    <code className="text-[13px] break-all text-foreground">{value}</code>
  )
  const facts: Array<{ label: string; value: ReactNode }> = [
    { label: "Requests go to", value: code(server.url) },
    {
      label: "Schema",
      value:
        server.specSource === "url" && server.specUrl ? (
          <>from {code(server.specUrl)}</>
        ) : (
          "Uploaded"
        ),
    },
    { label: "Read", value: <LocalDate value={server.lastSyncedAt} /> },
    {
      label: "Addresses",
      value: server.publicOnly
        ? "Public addresses only"
        : "Private addresses allowed",
    },
  ]

  return (
    <dl className="flex flex-col divide-y divide-separator rounded-lg bg-field">
      {facts.map((fact) => (
        <div
          key={fact.label}
          className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-3 py-2.5"
        >
          <dt className="w-32 shrink-0 text-xs text-muted-foreground">
            {fact.label}
          </dt>
          <dd className="min-w-0 flex-1 text-[13px]">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Last on the page, centred and red, with what it does. */
function RemoveServer({ server }: { server: ServerDetailProps["server"] }) {
  const what =
    server.kind === "openapi"
      ? "Deletes the endpoint, its tool list and PCP's copy of its schema. Secrets you added stay."
      : server.kind === "jmap" || server.kind === "imap"
        ? "Takes the account out of PCP, with its tool list and any OAuth tokens PCP holds for it. Your mail stays on the server, and secrets you added stay."
        : server.kind === "ssh"
          ? "Takes the server out of PCP and deletes PCP's key for it. Nothing on the server changes: take the key out of authorized_keys there too."
          : server.kind === "browser"
            ? "Takes the browser away from assistants and closes its tabs. The sign-ins it keeps stay until you forget them on the Browser page."
            : server.kind === "wrapper"
              ? "Deletes the wrapper and its tools. The tools it stands in for show in search again; secrets you added stay."
              : "Deletes the server, its tool list and any OAuth tokens PCP holds for it. Secrets you added stay."

  return (
    <div className="flex flex-col items-center gap-1.5 pt-2 text-center">
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
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        {what}
      </p>
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
      <Attention>
        <p>
          This sign-in to {server.name} lasts {lasts}, and PCP cannot renew it.
          Choose Reconnect above to fix that: PCP now asks for access it can
          renew.
        </p>
      </Attention>
    )
  }

  const prefix = `sign-in-params-${server.id}`

  return (
    <Attention>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={server.id} />
        <p>
          This sign-in to {server.name} lasts {lasts}, and PCP cannot renew it,
          so you would have to reconnect then. Many servers give renewable
          access only when the sign-in asks for it: enter what the server&apos;s
          documentation says, and sign in again.
        </p>
        <div className="text-foreground">
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
        </div>
        <FormError error={state.status === "error" ? state.error : null} />
        <div>
          <SubmitButton size="sm" pendingText="Saving…">
            Save and reconnect
          </SubmitButton>
        </div>
      </form>
    </Attention>
  )
}

/**
 * The client a server that does not let PCP register itself needs, asked for
 * where its status says so. Scope and sign-in parameters stay under
 * Advanced.
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
    <Attention>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={serverId} />
        <p>
          This server lets no app register itself. Create an OAuth client in the
          provider&apos;s developer settings with this redirect URI, and enter
          its client ID and secret here:
        </p>
        <div className="flex flex-col gap-4 text-foreground">
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
        </div>
        <FormError error={error} />
        <div>
          <SubmitButton size="sm" pendingText="Saving…">
            Save client
          </SubmitButton>
        </div>
      </form>
    </Attention>
  )
}
