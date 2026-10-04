"use client"

import { useRouter } from "next/navigation"
import { type FormEvent, useActionState, useEffect, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  disableDdnsAction,
  disableHttpsAction,
  type NetworkResult,
  retryHttpsAction,
  saveDdnsAction,
  saveHttpsAction,
  updateDdnsNowAction,
} from "@/lib/actions/network"
import { type SettingsResult, setPublicUrlAction } from "@/lib/actions/settings"
import {
  DDNS_PROVIDER_LABELS,
  DDNS_PROVIDERS,
  type DdnsProvider,
  DYNDNS2_SERVERS,
  LETS_ENCRYPT_TERMS_URL,
} from "@/lib/core/constants"
import type { NetworkOverview } from "@/lib/core/network/runtime"

export const SELF_HOSTING_GUIDE =
  "https://github.com/kaperkunde/pcp/blob/main/docs/self-hosting.md"

const KEEP = "Saved — leave blank to keep it"

function confirmed(question: string) {
  return (event: FormEvent<HTMLFormElement>) => {
    if (!window.confirm(question)) {
      event.preventDefault()
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic DNS

export function DdnsCard({ ddns }: { ddns: NetworkOverview["ddns"] }) {
  const [state, action] = useActionState<NetworkResult, FormData>(
    saveDdnsAction,
    { status: "idle" },
  )
  const [provider, setProvider] = useState<DdnsProvider>(
    ddns?.provider ?? "duckdns",
  )
  const saved = ddns?.provider === provider

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dynamic DNS</CardTitle>
        <CardDescription>
          Most home internet connections get a new address now and then. A
          dynamic DNS service gives you a name that stays the same, and PCP
          keeps it pointed at your connection: it checks every few minutes and
          tells the service when the address changes. Leave this off if PCP runs
          on a server with an address that does not change.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
            <>
              <Field
                label="Your DuckDNS name"
                htmlFor="ddns-subdomain"
                hint="The part before .duckdns.org."
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="ddns-subdomain"
                    name="subdomain"
                    defaultValue={saved ? ddns?.subdomain : ""}
                    placeholder="pcp-yourname"
                    required
                  />
                  <span className="text-sm text-muted-foreground">
                    .duckdns.org
                  </span>
                </div>
              </Field>
              <Field label="DuckDNS token" htmlFor="ddns-token">
                <Input
                  id="ddns-token"
                  name="token"
                  type="password"
                  autoComplete="off"
                  placeholder={saved ? KEEP : ""}
                  required={!saved}
                />
              </Field>
            </>
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
            Unlike your secrets, this login is stored on your server
            unencrypted, so PCP can use it while you are signed out. Someone who
            reads it can change where your name points, and nothing else.
          </p>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText="Saving and updating…">
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
              <SubmitButton variant="outline" pendingText="Turning off…">
                Turn dynamic DNS off
              </SubmitButton>
            </form>
          </div>
        ) : null}
      </CardContent>
    </Card>
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
      <SubmitButton variant="outline" pendingText="Updating…">
        Update now
      </SubmitButton>
      <FormError error={state.status === "error" ? state.error : null} />
    </form>
  )
}

// ---------------------------------------------------------------------------
// HTTPS

export function HttpsCard({
  https,
  ddnsName,
  ports,
  pinnedPublicUrl,
}: {
  https: NetworkOverview["https"]
  ddnsName: string | null
  ports: NetworkOverview["ports"]
  pinnedPublicUrl: string | null
}) {
  const [state, action] = useActionState<NetworkResult, FormData>(
    saveHttpsAction,
    { status: "idle" },
  )
  const [useDdnsName, setUseDdnsName] = useState(
    !!ddnsName && (!https || https.typedDomain === null),
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>HTTPS</CardTitle>
        <CardDescription>
          Lets PCP get a free certificate from Let&apos;s Encrypt and serve
          itself over HTTPS, which most sign-ins with other services need. Your
          router has to forward ports 80 and 443 to this computer. Leave this
          off if something else (Caddy, Traefik, nginx, Coolify) already handles
          HTTPS for PCP.{" "}
          <a
            href={SELF_HOSTING_GUIDE}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            The self-hosting guide
          </a>{" "}
          walks through it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {https ? (
          <HttpsStatus
            https={https}
            ports={ports}
            pinnedPublicUrl={pinnedPublicUrl}
          />
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
                defaultValue={https?.typedDomain ?? ""}
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
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText="Saving…">
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
            <SubmitButton variant="outline" pendingText="Turning off…">
              Turn HTTPS off
            </SubmitButton>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

function HttpsStatus({
  https,
  ports,
  pinnedPublicUrl,
}: {
  https: NonNullable<NetworkOverview["https"]>
  ports: NetworkOverview["ports"]
  pinnedPublicUrl: string | null
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
      {edge && (ports.http !== 80 || ports.https !== 443) ? (
        <p className="text-muted-foreground">
          PCP listens on ports {ports.http} and {ports.https}; your router or
          Docker should send ports 80 and 443 there.
        </p>
      ) : null}
      {status.state === "active" && address && pinnedPublicUrl !== address ? (
        <UsePublicAddress address={address} />
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
      <SubmitButton variant="outline" pendingText="Asking…">
        Try again now
      </SubmitButton>
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

function UsePublicAddress({ address }: { address: string }) {
  const [state, action] = useActionState<SettingsResult, FormData>(
    setPublicUrlAction,
    { status: "idle" },
  )

  if (state.status === "ok") {
    return <FormNote message={state.message} />
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="publicUrl" value={address} />
      <p className="text-muted-foreground">
        Sign-ins with other services and the address you give assistants use
        PCP&apos;s public address.
      </p>
      <div>
        <SubmitButton variant="outline" pendingText="Saving…">
          Use {address} as PCP&apos;s public address
        </SubmitButton>
      </div>
      <FormError error={state.status === "error" ? state.error : null} />
    </form>
  )
}
