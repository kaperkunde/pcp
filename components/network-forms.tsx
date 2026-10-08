"use client"

import { Cable, Lock, RefreshCw } from "lucide-react"
import { useRouter } from "next/navigation"
import { type FormEvent, useActionState, useEffect, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { PublicUrlConfirm } from "@/components/settings-forms"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  disableDdnsAction,
  disableHttpsAction,
  disablePcpggAction,
  type NetworkResult,
  retryHttpsAction,
  retryPcpggHttpsAction,
  saveDdnsAction,
  saveHttpsAction,
  savePcpggAction,
  updateDdnsNowAction,
} from "@/lib/actions/network"
import {
  DDNS_PROVIDER_LABELS,
  DDNS_PROVIDERS,
  type DdnsProvider,
  DUCKDNS_URL,
  DYNDNS2_SERVERS,
  LETS_ENCRYPT_TERMS_URL,
  PCPGG_URL,
  readDuckDnsPaste,
} from "@/lib/core/constants"
import type { NetworkOverview } from "@/lib/core/network/runtime"

export const SELF_HOSTING_GUIDE =
  "https://github.com/kaperkunde/pcp/blob/main/docs/self-hosting.md"

const KEEP = "Saved — leave blank to keep it"

/**
 * `row` is a folded row of Settings' Network list; `card` is the same form
 * as a panel of its own, on the setup step.
 */
type Variant = "row" | "card"

function confirmed(question: string) {
  return (event: FormEvent<HTMLFormElement>) => {
    if (!window.confirm(question)) {
      event.preventDefault()
    }
  }
}

function LetsEncryptAgreement() {
  return (
    <Label className="font-normal">
      <Checkbox name="agreed" required />
      <span>
        I accept the{" "}
        <a
          href={LETS_ENCRYPT_TERMS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          Let&apos;s Encrypt Subscriber Agreement
        </a>
      </span>
    </Label>
  )
}

// ---------------------------------------------------------------------------
// pcp.gg

/** The grey line under "pcp.gg": whether it is on, and how it is doing. */
function pcpggState(pcpgg: NetworkOverview["pcpgg"]) {
  if (!pcpgg) return "Off"

  switch (pcpgg.state) {
    case "online":
      return pcpgg.name ? `Online at ${pcpgg.name}` : "Online"
    case "rejected":
      return "Key not accepted"
    case "offline":
      return "Offline"
    default:
      return "Connecting…"
  }
}

export function PcpggCard({
  pcpgg,
  ports,
  pinnedPublicUrl,
  username,
  variant = "card",
}: {
  pcpgg: NetworkOverview["pcpgg"]
  ports: NetworkOverview["ports"]
  pinnedPublicUrl: string | null
  /** For the password asked before PCP's public address changes. */
  username: string
  variant?: Variant
}) {
  const buttonVariant = variant === "row" ? "secondary" : "default"
  const [state, action] = useActionState<NetworkResult, FormData>(
    savePcpggAction,
    { status: "idle" },
  )

  return (
    <SettingsItem
      variant={variant}
      id="pcpgg"
      title="pcp.gg"
      icon={Cable}
      state={pcpggState(pcpgg)}
      about="pcp.gg gives PCP a name of its own, such as you.pcp.gg, and carries connections to that name to this computer over a connection PCP opens itself. Assistants reach PCP from anywhere, with nothing to change on your router and nothing else to run. PCP gets its own certificate for the name from Let's Encrypt, so what passes through pcp.gg stays encrypted to PCP."
      defaultOpen={
        pcpgg?.state === "rejected" ||
        pcpgg?.state === "offline" ||
        Boolean(pcpgg?.httpsTurnedOff)
      }
    >
      {pcpgg ? (
        <PcpggStatus
          pcpgg={pcpgg}
          ports={ports}
          pinnedPublicUrl={pinnedPublicUrl}
          username={username}
        />
      ) : null}
      <form action={action} className="flex flex-col gap-4" aria-label="pcp.gg">
        {pcpgg ? null : (
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
            <li>
              Sign in at pcp.gg and choose your name.{" "}
              <ButtonLink
                href={PCPGG_URL}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                size="sm"
                className="ml-1"
              >
                Open pcp.gg
              </ButtonLink>
            </li>
            <li>
              Copy the <strong>connection key</strong> from your pcp.gg
              dashboard and paste it below.
            </li>
          </ol>
        )}
        <Field
          label="Connection key"
          htmlFor="pcpgg-key"
          hint={
            pcpgg
              ? `Saved: ${pcpgg.keyHint} Paste a new one when you replace it on pcp.gg.`
              : undefined
          }
        >
          <Input
            id="pcpgg-key"
            name="key"
            type="password"
            autoComplete="off"
            placeholder={pcpgg ? KEEP : "pcpgg_…"}
            required={!pcpgg}
          />
        </Field>
        <LetsEncryptAgreement />
        <p className="text-xs text-muted-foreground">
          Unlike your secrets, this key is stored on your server unencrypted, so
          PCP stays connected while you are signed out. Someone who reads it
          could answer for your pcp.gg name until you replace the key on pcp.gg;
          it opens nothing in PCP.
        </p>
        <FormError error={state.status === "error" ? state.error : null} />
        <FormNote message={state.status === "ok" ? state.message : null} />
        <div>
          <SubmitButton variant={buttonVariant} pendingText="Connecting…">
            {pcpgg ? "Save and connect" : "Connect to pcp.gg"}
          </SubmitButton>
        </div>
      </form>
      {pcpgg ? (
        <form
          action={disablePcpggAction}
          onSubmit={confirmed(
            `Disconnect from pcp.gg? Assistants can no longer reach PCP${
              pcpgg.name ? ` at ${pcpgg.name}` : ""
            }, and PCP stops serving HTTPS for that name.`,
          )}
        >
          <SubmitButton variant="secondary" pendingText="Disconnecting…">
            Disconnect from pcp.gg
          </SubmitButton>
        </form>
      ) : null}
    </SettingsItem>
  )
}

function PcpggStatus({
  pcpgg,
  ports,
  pinnedPublicUrl,
  username,
}: {
  pcpgg: NonNullable<NetworkOverview["pcpgg"]>
  ports: NetworkOverview["ports"]
  pinnedPublicUrl: string | null
  username: string
}) {
  const router = useRouter()
  const { state, name, error, retryAt, https, httpsTurnedOff } = pcpgg
  const waiting =
    state === "connecting" || (state === "online" && !https && !httpsTurnedOff)

  // Connecting takes a moment: follow along until it is online.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => router.refresh(), 3_000)
    return () => clearInterval(timer)
  }, [waiting, router])

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pcpgg-status">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {state === "online" ? (
            <Badge>Online</Badge>
          ) : state === "rejected" ? (
            <Badge variant="destructive">Key not accepted</Badge>
          ) : state === "offline" ? (
            <Badge variant="warning">Offline</Badge>
          ) : (
            <Badge variant="outline">Connecting…</Badge>
          )}
          <span>
            {state === "online" && name ? (
              <>
                Assistants reach PCP at <strong>{name}</strong>
              </>
            ) : name ? (
              <strong>{name}</strong>
            ) : (
              "Your pcp.gg name"
            )}
          </span>
        </div>
        {state === "rejected" ? (
          <p className="text-destructive" role="alert">
            {error} PCP will not try again until you save a key.
          </p>
        ) : state === "offline" ? (
          <>
            {error ? <p className="text-warning">{error}</p> : null}
            {retryAt ? (
              <p className="text-muted-foreground">
                PCP tries again at <LocalDate value={retryAt} />.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {state === "rejected" ? null : https ? (
        <HttpsStatus
          https={https}
          ports={ports}
          pinnedPublicUrl={pinnedPublicUrl}
          username={username}
        />
      ) : httpsTurnedOff ? (
        <div
          className="flex flex-col gap-2"
          data-testid="pcpgg-https-turned-off"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="destructive">No certificate</Badge>
          </div>
          <p className="text-destructive" role="alert">
            {httpsTurnedOff.error}
          </p>
          <p className="text-muted-foreground">
            PCP stopped asking at <LocalDate value={httpsTurnedOff.at} />.
          </p>
          <PcpggRetryButton />
        </div>
      ) : null}
    </div>
  )
}

function PcpggRetryButton() {
  const [state, action] = useActionState<NetworkResult>(retryPcpggHttpsAction, {
    status: "idle",
  })

  return (
    <form action={action} className="flex items-center gap-2">
      <SubmitButton variant="secondary" pendingText="Asking…">
        Try again now
      </SubmitButton>
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

// ---------------------------------------------------------------------------
// Dynamic DNS

/** The grey line under "Dynamic DNS": the name it keeps, and how it is doing. */
function ddnsState(ddns: NetworkOverview["ddns"]) {
  if (!ddns) return "Off"

  const { status, name } = ddns
  const how = status.stopped
    ? "stopped"
    : status.lastError
      ? "not updated"
      : status.lastUpdatedAt
        ? "working"
        : "waiting"

  return name ? `${name} · ${how}` : `On · ${how}`
}

export function DdnsCard({
  ddns,
  variant = "card",
}: {
  ddns: NetworkOverview["ddns"]
  variant?: Variant
}) {
  const buttonVariant = variant === "row" ? "secondary" : "default"
  const [state, action] = useActionState<NetworkResult, FormData>(
    saveDdnsAction,
    { status: "idle" },
  )
  const [provider, setProvider] = useState<DdnsProvider>(
    ddns?.provider ?? "duckdns",
  )
  const saved = ddns?.provider === provider

  return (
    <SettingsItem
      variant={variant}
      id="ddns"
      title="Dynamic DNS"
      icon={RefreshCw}
      state={ddnsState(ddns)}
      about="Most home internet connections get a new address now and then. A dynamic DNS service gives you a name that stays the same, and PCP keeps it pointed at your connection: it checks every few minutes and tells the service when the address changes. Leave this off if PCP runs on a server with an address that does not change."
      defaultOpen={Boolean(ddns?.status.stopped)}
    >
      {ddns ? <DdnsStatusLine ddns={ddns} /> : null}
      <form
        action={action}
        className="flex flex-col gap-4"
        aria-label="Dynamic DNS"
      >
        <Field
          label="Service"
          htmlFor="ddns-provider"
          hint={DDNS_PROVIDER_LABELS[provider].hint}
        >
          <Select
            id="ddns-provider"
            name="provider"
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as DdnsProvider)
            }
          >
            {DDNS_PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {DDNS_PROVIDER_LABELS[value].label}
              </option>
            ))}
          </Select>
        </Field>

        {provider === "duckdns" ? (
          <DuckDnsFields ddns={saved ? ddns : null} />
        ) : null}

        {provider === "dyndns2" ? (
          <Dyndns2Fields ddns={saved ? ddns : null} />
        ) : null}

        {provider === "cloudflare" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Domain"
                htmlFor="ddns-zone"
                hint="The domain as Cloudflare lists it."
              >
                <Input
                  id="ddns-zone"
                  name="zone"
                  defaultValue={saved ? ddns?.zone : ""}
                  placeholder="example.com"
                  required
                />
              </Field>
              <Field
                label="Name to update"
                htmlFor="ddns-record"
                hint="Made if it does not exist yet. @ for the domain itself."
              >
                <Input
                  id="ddns-record"
                  name="record"
                  defaultValue={saved ? ddns?.record : ""}
                  placeholder="pcp.example.com"
                  required
                />
              </Field>
            </div>
            <Field
              label="API token"
              htmlFor="ddns-api-token"
              hint="Make one in Cloudflare under My Profile → API Tokens, with the “Edit zone DNS” template, for this domain only."
            >
              <Input
                id="ddns-api-token"
                name="apiToken"
                type="password"
                autoComplete="off"
                placeholder={saved ? KEEP : ""}
                required={!saved}
              />
            </Field>
          </>
        ) : null}

        {provider === "custom" ? (
          <>
            <Field
              label="Update address"
              htmlFor="ddns-url"
              hint={
                <>
                  PCP opens it with GET. <code>{"{ip}"}</code> becomes your
                  address and <code>{"{hostname}"}</code> the name below; a
                  login goes in the address, as in
                  https://user:password@example.com/update?ip=&#123;ip&#125;.
                  {saved && ddns?.urlHost
                    ? ` Saved: an address on ${ddns.urlHost}.`
                    : ""}
                </>
              }
            >
              <Input
                id="ddns-url"
                name="url"
                type="password"
                autoComplete="off"
                placeholder={
                  saved ? KEEP : "https://example.com/update?ip={ip}"
                }
                required={!saved}
              />
            </Field>
            <Field
              label="The name it updates (optional)"
              htmlFor="ddns-hostname"
              hint="Needed if you want HTTPS to use it."
            >
              <Input
                id="ddns-hostname"
                name="hostname"
                defaultValue={saved ? ddns?.hostname : ""}
                placeholder="pcp.example.com"
              />
            </Field>
          </>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Unlike your secrets, this login is stored on your server unencrypted,
          so PCP can use it while you are signed out. Someone who reads it can
          change where your name points, and nothing else.
        </p>
        <FormError error={state.status === "error" ? state.error : null} />
        <FormNote message={state.status === "ok" ? state.message : null} />
        <div>
          <SubmitButton
            variant={buttonVariant}
            pendingText="Saving and updating…"
          >
            {ddns ? "Save and update" : "Turn on dynamic DNS"}
          </SubmitButton>
        </div>
      </form>
      {ddns ? (
        <div className="flex flex-wrap gap-2">
          <UpdateNowButton />
          <form
            action={disableDdnsAction}
            onSubmit={confirmed(
              "Turn dynamic DNS off? Your name stops following your address.",
            )}
          >
            <SubmitButton variant="secondary" pendingText="Turning off…">
              Turn dynamic DNS off
            </SubmitButton>
          </form>
        </div>
      ) : null}
    </SettingsItem>
  )
}

function DuckDnsFields({ ddns }: { ddns: NetworkOverview["ddns"] | null }) {
  const [subdomain, setSubdomain] = useState(ddns?.subdomain ?? "")
  const [token, setToken] = useState("")
  const [found, setFound] = useState<string | null>(null)

  // Whatever is pasted, keep the token in it, and take the name too when
  // it is there and none is typed yet.
  const onToken = (value: string) => {
    const pasted = readDuckDnsPaste(value)

    if (pasted.token && pasted.token !== value.trim()) {
      setToken(pasted.token)
      const name = !subdomain && pasted.subdomain ? pasted.subdomain : null
      if (name) setSubdomain(name)
      setFound(
        name
          ? `Found the token and the name ${name} in what you pasted.`
          : "Found the token in what you pasted.",
      )
      return
    }

    setToken(value)
    setFound(null)
  }

  return (
    <>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        <li>
          Open DuckDNS and sign in, with GitHub, Google or another account you
          have.{" "}
          <ButtonLink
            href={DUCKDNS_URL}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            size="sm"
            className="ml-1"
          >
            Open duckdns.org
          </ButtonLink>
        </li>
        <li>
          Type a name under <strong>sub domain</strong> and choose{" "}
          <strong>add domain</strong>. Pick one that says nothing about PCP: a
          name that gives away what runs behind it helps people looking for such
          servers to attack.
        </li>
        <li>
          Copy the <strong>token</strong> shown at the top of the page and paste
          it below. Copying the whole line from DuckDNS&apos;s{" "}
          <strong>install</strong> page works too: PCP picks the token and the
          name out of it.
        </li>
      </ol>
      <Field
        label="Your DuckDNS name"
        htmlFor="ddns-subdomain"
        hint="The part before .duckdns.org."
      >
        <div className="flex items-center gap-2">
          <Input
            id="ddns-subdomain"
            name="subdomain"
            value={subdomain}
            onChange={(event) => setSubdomain(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          <span className="text-sm text-muted-foreground">.duckdns.org</span>
        </div>
      </Field>
      <Field
        label="DuckDNS token"
        htmlFor="ddns-token"
        hint={found ?? undefined}
      >
        <Input
          id="ddns-token"
          name="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => onToken(event.target.value)}
          placeholder={ddns ? KEEP : ""}
          required={!ddns}
        />
      </Field>
    </>
  )
}

function Dyndns2Fields({ ddns }: { ddns: NetworkOverview["ddns"] | null }) {
  const known = ddns?.server && ddns.server in DYNDNS2_SERVERS
  const [server, setServer] = useState(
    ddns?.server ? (known ? ddns.server : "other") : "dynupdate.no-ip.com",
  )

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Which service" htmlFor="ddns-server-choice">
          <Select
            id="ddns-server-choice"
            name={server === "other" ? undefined : "server"}
            value={server}
            onChange={(event) => setServer(event.target.value)}
          >
            {Object.entries(DYNDNS2_SERVERS).map(([host, label]) => (
              <option key={host} value={host}>
                {label}
              </option>
            ))}
            <option value="other">Another one</option>
          </Select>
        </Field>
        {server === "other" ? (
          <Field
            label="Its update server"
            htmlFor="ddns-server"
            hint="PCP calls https://<server>/nic/update."
          >
            <Input
              id="ddns-server"
              name="server"
              defaultValue={known ? "" : (ddns?.server ?? "")}
              placeholder="members.example.com"
              required
            />
          </Field>
        ) : null}
      </div>
      <Field label="Host name" htmlFor="ddns-hostname">
        <Input
          id="ddns-hostname"
          name="hostname"
          defaultValue={ddns?.hostname ?? ""}
          placeholder="pcp.ddns.net"
          required
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username" htmlFor="ddns-username">
          <Input
            id="ddns-username"
            name="username"
            autoComplete="off"
            defaultValue={ddns?.username ?? ""}
            required
          />
        </Field>
        <Field
          label="Password"
          htmlFor="ddns-password"
          hint="Some services give you a separate update password or key; use it if they do."
        >
          <Input
            id="ddns-password"
            name="password"
            type="password"
            autoComplete="off"
            placeholder={ddns ? KEEP : ""}
            required={!ddns}
          />
        </Field>
      </div>
    </>
  )
}

function DdnsStatusLine({
  ddns,
}: {
  ddns: NonNullable<NetworkOverview["ddns"]>
}) {
  const { status, name } = ddns

  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="ddns-status">
      <div className="flex flex-wrap items-center gap-2">
        {status.stopped ? (
          <Badge variant="destructive">Stopped</Badge>
        ) : status.lastError ? (
          <Badge variant="warning">Not updated</Badge>
        ) : status.lastUpdatedAt ? (
          <Badge>Working</Badge>
        ) : (
          <Badge variant="outline">Waiting</Badge>
        )}
        <span>
          {name ? <strong>{name}</strong> : "Your name"}
          {status.lastIp ? <> points at {status.lastIp}</> : null}
        </span>
      </div>
      {status.lastUpdatedAt ? (
        <p className="text-muted-foreground">
          Last told the service: <LocalDate value={status.lastUpdatedAt} />
        </p>
      ) : null}
      {status.stopped ? (
        <p className="text-destructive" role="alert">
          {status.stopped} PCP will not try again until you save the settings.
        </p>
      ) : status.lastError ? (
        <p className="text-warning">{status.lastError}</p>
      ) : null}
    </div>
  )
}

function UpdateNowButton() {
  const [state, action] = useActionState<NetworkResult>(updateDdnsNowAction, {
    status: "idle",
  })

  return (
    <form action={action} className="flex items-center gap-2">
      <SubmitButton variant="secondary" pendingText="Updating…">
        Update now
      </SubmitButton>
      <FormError error={state.status === "error" ? state.error : null} />
    </form>
  )
}

// ---------------------------------------------------------------------------
// HTTPS

/** The grey line under "HTTPS": which name it serves, or why it is off. */
function httpsState(
  https: NetworkOverview["https"],
  turnedOff: NetworkOverview["httpsTurnedOff"],
  pcpggName: string | null | undefined,
) {
  if (pcpggName !== undefined) return "Through pcp.gg"
  if (https) {
    return https.status.state === "failed"
      ? "No certificate"
      : https.domain
        ? `On for ${https.domain}`
        : "On"
  }

  return turnedOff ? "Turned off" : "Off"
}

export function HttpsCard({
  https,
  turnedOff,
  ddnsName,
  ports,
  pinnedPublicUrl,
  username,
  pcpggName,
  variant = "card",
}: {
  https: NetworkOverview["https"]
  turnedOff: NetworkOverview["httpsTurnedOff"]
  ddnsName: string | null
  ports: NetworkOverview["ports"]
  pinnedPublicUrl: string | null
  /** For the password asked before PCP's public address changes. */
  username: string
  /** Set while PCP is connected to pcp.gg, which looks after HTTPS. */
  pcpggName?: string | null
  variant?: Variant
}) {
  const buttonVariant = variant === "row" ? "secondary" : "default"
  const [state, action] = useActionState<NetworkResult, FormData>(
    saveHttpsAction,
    { status: "idle" },
  )
  // After a failed first try, the name it was for comes back as it was.
  const lastDomain = https ? https.typedDomain : (turnedOff?.domain ?? null)
  const [useDdnsName, setUseDdnsName] = useState(
    !!ddnsName && (lastDomain === null || lastDomain === ddnsName),
  )

  return (
    <SettingsItem
      variant={variant}
      id="https"
      title="HTTPS"
      icon={Lock}
      state={httpsState(https, turnedOff, pcpggName)}
      about={
        <>
          Lets PCP get a free certificate from Let&apos;s Encrypt and serve
          itself over HTTPS, which most sign-ins with other services need. Your
          router has to forward ports 80 and 443 to this computer. Leave this
          off if something else (Caddy, Traefik, nginx, Coolify) already handles
          HTTPS for PCP, or if you connect to pcp.gg, which needs no ports
          forwarded.{" "}
          <a
            href={SELF_HOSTING_GUIDE}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            The self-hosting guide
          </a>{" "}
          walks through it.
        </>
      }
      defaultOpen={
        pcpggName === undefined &&
        (Boolean(turnedOff) ||
          Boolean(https?.status.lastError && https.status.state !== "issuing"))
      }
    >
      {pcpggName !== undefined ? (
        <>
          <p
            className="text-sm text-muted-foreground"
            data-testid="https-pcpgg"
          >
            While PCP is connected to pcp.gg, it serves HTTPS for its pcp.gg
            name{pcpggName ? `, ${pcpggName}` : ""}: the pcp.gg card shows how
            that goes. Disconnect from pcp.gg to use another name here.
          </p>
        </>
      ) : (
        <>
          {https ? (
            <HttpsStatus
              https={https}
              ports={ports}
              pinnedPublicUrl={pinnedPublicUrl}
              username={username}
            />
          ) : turnedOff ? (
            <div
              className="flex flex-col gap-2 text-sm"
              data-testid="https-turned-off"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">Turned off</Badge>
                {turnedOff.domain ? <strong>{turnedOff.domain}</strong> : null}
              </div>
              <p className="text-destructive" role="alert">
                {turnedOff.error}
              </p>
              <p className="text-muted-foreground">
                PCP turned HTTPS off at <LocalDate value={turnedOff.at} />{" "}
                rather than keep asking: a first try usually fails for a reason
                that does not go away by itself. Fix what it says, then turn
                HTTPS on again below.
              </p>
            </div>
          ) : null}
          <form
            action={action}
            className="flex flex-col gap-4"
            aria-label="HTTPS"
          >
            {ddnsName ? (
              <Label className="font-normal">
                <Checkbox
                  name="useDdnsName"
                  checked={useDdnsName}
                  onChange={(event) => setUseDdnsName(event.target.checked)}
                />
                Use my dynamic DNS name, {ddnsName}
              </Label>
            ) : null}
            {!useDdnsName ? (
              <Field
                label="The name PCP is reached on"
                htmlFor="https-domain"
                hint="It has to point at this network already."
              >
                <Input
                  id="https-domain"
                  name="domain"
                  defaultValue={lastDomain ?? ""}
                  placeholder="pcp.example.com"
                  required
                />
              </Field>
            ) : null}
            <Field
              label="Email (optional)"
              htmlFor="https-email"
              hint="Let's Encrypt only writes about problems with your account."
            >
              <Input
                id="https-email"
                name="email"
                type="email"
                defaultValue={https?.email ?? ""}
              />
            </Field>
            <LetsEncryptAgreement />
            <FormError error={state.status === "error" ? state.error : null} />
            <FormNote message={state.status === "ok" ? state.message : null} />
            <div>
              <SubmitButton variant={buttonVariant} pendingText="Saving…">
                {https ? "Save" : "Turn on HTTPS"}
              </SubmitButton>
            </div>
          </form>
          {https ? (
            <form
              action={disableHttpsAction}
              onSubmit={confirmed(
                "Turn HTTPS off? PCP stops answering on ports 80 and 443.",
              )}
            >
              <SubmitButton variant="secondary" pendingText="Turning off…">
                Turn HTTPS off
              </SubmitButton>
            </form>
          ) : null}
        </>
      )}
    </SettingsItem>
  )
}

function HttpsStatus({
  https,
  ports,
  pinnedPublicUrl,
  username,
}: {
  https: NonNullable<NetworkOverview["https"]>
  ports: NetworkOverview["ports"]
  pinnedPublicUrl: string | null
  username: string
}) {
  const router = useRouter()
  const { status, edge, domain } = https
  const issuing = status.state === "issuing" || !status.state
  const address = domain ? `https://${domain}` : null

  // Let's Encrypt takes a moment: follow along until it answers.
  useEffect(() => {
    if (!issuing) return
    const timer = setInterval(() => router.refresh(), 5_000)
    return () => clearInterval(timer)
  }, [issuing, router])

  const listenErrors = [edge?.http.error, edge?.https.error].filter(Boolean)

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="https-status">
      <div className="flex flex-wrap items-center gap-2">
        {status.state === "active" ? (
          <Badge>Working</Badge>
        ) : status.state === "failed" ? (
          <Badge variant="destructive">No certificate</Badge>
        ) : (
          <Badge variant="outline">Getting a certificate…</Badge>
        )}
        {domain ? <strong>{domain}</strong> : null}
      </div>
      {status.state === "active" && status.notAfter ? (
        <p className="text-muted-foreground">
          The certificate lasts until <LocalDate value={status.notAfter} />; PCP
          renews it on its own.
        </p>
      ) : null}
      {status.warning ? <p className="text-warning">{status.warning}</p> : null}
      {status.lastError ? (
        <div className="flex flex-col gap-2">
          <p className="text-destructive" role="alert">
            {status.lastError}
          </p>
          {status.nextAttemptAt ? (
            <p className="text-muted-foreground">
              PCP tries again at <LocalDate value={status.nextAttemptAt} />.
            </p>
          ) : null}
          <RetryButton />
        </div>
      ) : null}
      {listenErrors.map((error) => (
        <p key={error} className="text-destructive" role="alert">
          {error}
        </p>
      ))}
      {edge && !https.viaPcpgg && (ports.http !== 80 || ports.https !== 443) ? (
        <p className="text-muted-foreground">
          PCP listens on ports {ports.http} and {ports.https}; your router or
          Docker should send ports 80 and 443 there.
        </p>
      ) : null}
      {status.state === "active" && address && pinnedPublicUrl !== address ? (
        <UsePublicAddress address={address} username={username} />
      ) : null}
    </div>
  )
}

function RetryButton() {
  const [state, action] = useActionState<NetworkResult>(retryHttpsAction, {
    status: "idle",
  })

  return (
    <form action={action} className="flex items-center gap-2">
      <SubmitButton variant="secondary" pendingText="Asking…">
        Try again now
      </SubmitButton>
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

function UsePublicAddress({
  address,
  username,
}: {
  address: string
  username: string
}) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  if (saved) {
    return <FormNote message={saved} />
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        Sign-ins with other services and the address you give assistants use
        PCP&apos;s public address.
      </p>
      {open ? (
        <PublicUrlConfirm
          address={address}
          username={username}
          idPrefix="use-public-url"
          onBack={() => setOpen(false)}
          onSaved={setSaved}
        />
      ) : (
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setOpen(true)}
          >
            Use {address} as PCP&apos;s public address
          </Button>
        </div>
      )}
    </div>
  )
}
