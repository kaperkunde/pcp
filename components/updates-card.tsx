"use client"

import { useActionState } from "react"

import { CopyableValue } from "@/components/copyable-value"
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
import {
  checkForUpdatesAction,
  setUpdateCheckAction,
  type UpdatesResult,
} from "@/lib/actions/updates"
import type { UpdatesOverview } from "@/lib/core/updates/state"
import { REPOSITORY_URL } from "@/lib/operator-identity"
import type { InstallKind } from "@/lib/server/install-kind"

const INSTALL_LINE =
  "curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh"
const COMPOSE_LINE = "docker compose pull && docker compose up -d"
const SOURCE_LINE = "git pull && pnpm install && pnpm db:generate && pnpm build"
const DOWNLOADS = [
  { label: "Mac (Apple silicon)", file: "PCP-mac-arm64.dmg" },
  { label: "Mac (Intel)", file: "PCP-mac-x64.dmg" },
  { label: "Windows", file: "PCP-windows-x64.exe" },
]

const DISCLOSURE =
  "PCP asks GitHub once a day which release is the latest. GitHub sees this PCP's address and version, nothing else."

function ExternalLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  )
}

/**
 * Settings → Updates: which version this is, what the last check found,
 * the daily check on or off, "Check now", and how to update this PCP for
 * the way it was installed.
 */
export function UpdatesCard({
  overview,
  host,
}: {
  overview: UpdatesOverview
  host: InstallKind
}) {
  return (
    <Card id="updates" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          PCP tells you when a new release is out, here and in its header.
          Updating is up to you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UpdateStatusLine overview={overview} />
        <CheckNowButton />
        <UpdateCheckSwitch check={overview.check} />
        <HowToUpdate host={host} />
      </CardContent>
    </Card>
  )
}

/** The setup step's card: only the daily check, and what it sends. */
export function UpdateCheckCard({ check }: { check: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New releases</CardTitle>
        <CardDescription>
          PCP can tell you when a new release is out, in its header and under
          Settings. Updating stays up to you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UpdateCheckSwitch check={check} />
      </CardContent>
    </Card>
  )
}

function UpdateStatusLine({ overview }: { overview: UpdatesOverview }) {
  const { current, latest, available, check, checkedAt, error, retryAt } =
    overview

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="updates-status">
      <div className="flex flex-wrap items-center gap-2">
        {available ? (
          <Badge variant="warning">Update available</Badge>
        ) : latest ? (
          <Badge>Up to date</Badge>
        ) : check ? (
          <Badge variant="outline">Not checked yet</Badge>
        ) : (
          <Badge variant="outline">Checking is off</Badge>
        )}
        <span>
          {available && latest ? (
            <>
              <strong>v{latest.version}</strong> is out. This PCP is v{current}.
            </>
          ) : latest && latest.version !== current ? (
            <>
              This PCP is v{current}, newer than the latest release, v
              {latest.version}.
            </>
          ) : latest ? (
            <>This PCP is v{current}, the latest release.</>
          ) : (
            <>This PCP is v{current}.</>
          )}
        </span>
      </div>
      {available && latest ? (
        <p className="text-muted-foreground">
          {latest.publishedAt ? (
            <>
              Published <LocalDate value={latest.publishedAt} />.{" "}
            </>
          ) : null}
          <ExternalLink href={latest.url}>What&apos;s new</ExternalLink>
        </p>
      ) : null}
      {available && latest?.notes ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">Release notes</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/40 p-3 font-sans text-xs whitespace-pre-wrap text-foreground">
            {latest.notes}
          </pre>
        </details>
      ) : null}
      {error ? (
        <p className="text-warning">
          {error}
          {check && retryAt ? (
            <>
              {" "}
              PCP tries again at <LocalDate value={retryAt} />.
            </>
          ) : null}
        </p>
      ) : null}
      {checkedAt ? (
        <p className="text-muted-foreground">
          Last checked <LocalDate value={checkedAt} />.
        </p>
      ) : null}
    </div>
  )
}

function CheckNowButton() {
  const [state, action] = useActionState<UpdatesResult>(checkForUpdatesAction, {
    status: "idle",
  })

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label="Check for updates"
    >
      <SubmitButton variant="outline" pendingText="Checking…">
        Check now
      </SubmitButton>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

function UpdateCheckSwitch({ check }: { check: boolean }) {
  const [state, action] = useActionState<UpdatesResult, FormData>(
    setUpdateCheckAction,
    { status: "idle" },
  )

  return (
    <form
      action={action}
      className="flex flex-col gap-2"
      aria-label="Daily check for new releases"
    >
      <input type="hidden" name="check" value={check ? "off" : "on"} />
      <p>
        {check
          ? "PCP checks for new releases once a day."
          : "PCP does not check for new releases by itself."}
      </p>
      <p className="text-xs text-muted-foreground">
        {DISCLOSURE}
        {check
          ? ""
          : " While this is off, nothing is sent unless you choose Check now."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton
          variant="outline"
          size="sm"
          pendingText={check ? "Turning off…" : "Turning on…"}
        >
          {check ? "Turn off the daily check" : "Turn on the daily check"}
        </SubmitButton>
        <FormError error={state.status === "error" ? state.error : null} />
      </div>
    </form>
  )
}

function HowToUpdate({ host }: { host: InstallKind }) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="font-medium">How to update this PCP</h3>
      {host === "container" ? (
        <>
          <p className="text-muted-foreground">
            This PCP runs in a container. Updating means pulling the new image
            and starting the container again from it. Your vault is in the
            container&apos;s volume and stays.
          </p>
          <p>If you installed it with the install line, run it again:</p>
          <CopyableValue value={INSTALL_LINE} />
          <p>
            From a checkout with docker compose (add the same <code>-f</code>{" "}
            files you started it with):
          </p>
          <CopyableValue value={COMPOSE_LINE} />
          <p className="text-muted-foreground">
            If a deploy tool runs it (Coolify, Portainer, a NAS app), redeploy
            it there. PCP does not update itself in a container. Under Podman,{" "}
            <code>systemctl --user enable --now podman-auto-update.timer</code>{" "}
            fetches new releases once a day.
          </p>
        </>
      ) : host === "desktop" ? (
        <>
          <p className="text-muted-foreground">
            This is the PCP app. Download the new version for this computer and
            open it. Your vault stays where it is.
          </p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            {DOWNLOADS.map(({ label, file }) => (
              <ExternalLink
                key={file}
                href={`${REPOSITORY_URL}/releases/latest/download/${file}`}
              >
                {label}
              </ExternalLink>
            ))}
            <ExternalLink href={`${REPOSITORY_URL}/releases`}>
              All releases
            </ExternalLink>
          </p>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            This PCP runs from a checkout. In its folder:
          </p>
          <CopyableValue value={SOURCE_LINE} />
          <p className="text-muted-foreground">
            Then start it again (<code>pnpm start</code>, or the service you run
            it from). Your vault stays in its data folder.
          </p>
        </>
      )}
    </div>
  )
}
