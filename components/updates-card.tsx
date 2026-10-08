"use client"

import { Download } from "lucide-react"
import { useActionState, useRef } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { SettingsItem } from "@/components/settings-item"
import { Badge } from "@/components/ui/badge"
import { List } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import {
  checkForUpdatesAction,
  requestInstallAction,
  setUpdateCheckAction,
  type UpdatesResult,
} from "@/lib/actions/updates"
import type { UpdatesOverview } from "@/lib/core/updates/state"
import { REPOSITORY_URL } from "@/lib/operator-identity"
import type { InstallKind } from "@/lib/server/install-kind"

const INSTALL_LINE =
  "curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh"
const INSTALL_AUTO_LINE = INSTALL_LINE.replace(
  /\| sh$/,
  "| PCP_AUTO_UPDATE=1 sh",
)
const INSTALL_MANUAL_LINE = INSTALL_LINE.replace(
  /\| sh$/,
  "| PCP_AUTO_UPDATE=0 sh",
)
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

/** The grey line under "Updates": which release this is, or that one is out. */
function updatesState(overview: UpdatesOverview) {
  const { current, latest, available, check } = overview

  if (available && latest) {
    return (
      <span className="font-medium text-warning">
        v{latest.version} is out. This PCP is v{current}.
      </span>
    )
  }

  return `v${current}${
    latest ? ", the latest release" : check ? "" : ", checking is off"
  }`
}

/**
 * Settings → Updates: which version this is, what the last check found,
 * the daily check on or off, "Check now", and how to update this PCP for
 * the way it was installed. Open when a newer release is out.
 */
export function UpdatesCard({
  overview,
  host,
  desktopInstall,
  autoUpdated = false,
  hostUpdater = false,
}: {
  overview: UpdatesOverview
  host: InstallKind
  /** In the desktop app: whether it can install an update itself. */
  desktopInstall: "auto" | "manual" | null
  /** The Linux installer set this container up to update itself daily. */
  autoUpdated?: boolean
  /** The Linux installer installs an update when the owner asks here. */
  hostUpdater?: boolean
}) {
  return (
    <SettingsItem
      id="updates"
      title="Updates"
      icon={Download}
      tint="bg-tile-mcp text-tile-mcp-foreground"
      state={updatesState(overview)}
      about="PCP tells you when a new release is out, here and in its header. Updating is up to you."
      defaultOpen={overview.available}
    >
      <UpdateStatusLine overview={overview} />
      <CheckNowButton />
      <List className="bg-field">
        <UpdateCheckSwitch check={overview.check} />
      </List>
      <HowToUpdate
        host={host}
        desktopInstall={desktopInstall}
        autoUpdated={autoUpdated}
        hostUpdater={hostUpdater}
        overview={overview}
      />
    </SettingsItem>
  )
}

/** The setup step's card: only the daily check, and what it sends. */
export function UpdateCheckCard({ check }: { check: boolean }) {
  return (
    <SettingsItem
      variant="card"
      title="New releases"
      about="PCP can tell you when a new release is out, in its header and under Settings. Updating stays up to you."
    >
      <List className="bg-field">
        <UpdateCheckSwitch check={check} />
      </List>
    </SettingsItem>
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
      <SubmitButton variant="secondary" pendingText="Checking…">
        Check now
      </SubmitButton>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

function UpdateCheckSwitch({ check }: { check: boolean }) {
  const [state, action, pending] = useActionState<UpdatesResult, FormData>(
    setUpdateCheckAction,
    { status: "idle" },
  )
  const form = useRef<HTMLFormElement>(null)

  // The switch shows what PCP holds: it moves when the page has the new
  // value, not before, so a refused change leaves it where it was.
  return (
    <form
      ref={form}
      action={action}
      aria-label="Daily check for new releases"
      className="flex flex-col"
    >
      <input type="hidden" name="check" value={check ? "off" : "on"} />
      <SwitchRow
        id="update-check"
        label="Check for new releases once a day"
        description={`${DISCLOSURE}${
          check
            ? ""
            : " While this is off, nothing is sent unless you choose Check now."
        }`}
        checked={check}
        disabled={pending}
        onChange={() => form.current?.requestSubmit()}
      />
      {state.status === "error" ? (
        <FormError error={state.error} className="px-4 pb-3" />
      ) : null}
    </form>
  )
}

function InstallButton({ version }: { version: string }) {
  const [state, action] = useActionState<UpdatesResult>(requestInstallAction, {
    status: "idle",
  })

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label="Install the update"
    >
      <SubmitButton pendingText="Asking…">
        Install v{version} and restart
      </SubmitButton>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

function DownloadLinks() {
  return (
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
  )
}

function DesktopUpdate({
  desktopInstall,
  overview,
}: {
  desktopInstall: "auto" | "manual" | null
  overview: UpdatesOverview
}) {
  const { available, latest, installRequest } = overview

  if (desktopInstall === "auto") {
    return (
      <>
        {installRequest ? (
          <p role="status">
            The app is installing v{installRequest.version}. It downloads the
            new version and restarts by itself; your vault stays where it is.
          </p>
        ) : available && latest ? (
          <>
            <p className="text-muted-foreground">
              The app can install v{latest.version} itself: it downloads it from
              GitHub, restarts, and your vault stays where it is.
            </p>
            <InstallButton version={latest.version} />
          </>
        ) : (
          <p className="text-muted-foreground">
            This is the PCP app. When a new version is out, you can install it
            from here.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          If installing does not work, download the new version and open it:
        </p>
        <DownloadLinks />
      </>
    )
  }

  return (
    <>
      <p className="text-muted-foreground">
        This is the PCP app. Download the new version for this computer and open
        it. Your vault stays where it is.
      </p>
      <DownloadLinks />
    </>
  )
}

/** A container the Linux installer runs and watches for the owner's request. */
function InstallerUpdate({
  autoUpdated,
  overview,
}: {
  autoUpdated: boolean
  overview: UpdatesOverview
}) {
  const { available, latest, installRequest } = overview

  return (
    <>
      {installRequest ? (
        <p role="status">
          PCP is installing v{installRequest.version}. The installer on this
          computer fetches the new image and starts PCP again from it, which
          takes a minute or two; reload this page then. Your vault stays in its
          volume.
        </p>
      ) : available && latest ? (
        <>
          <p className="text-muted-foreground">
            The installer on this computer can install v{latest.version}: it
            fetches the new image and starts PCP again from it. Your vault stays
            in its volume.
          </p>
          <InstallButton version={latest.version} />
        </>
      ) : (
        <p className="text-muted-foreground">
          This PCP runs in a container the installer set up. When a new version
          is out, you can install it from here.
        </p>
      )}
      {autoUpdated ? (
        <p className="text-muted-foreground">
          The installer also updates it by itself once a day. To turn that off:
        </p>
      ) : null}
      {autoUpdated ? <CopyableValue value={INSTALL_MANUAL_LINE} /> : null}
      <p className="text-xs text-muted-foreground">
        If installing does not work, run the install line again:
      </p>
      <CopyableValue value={INSTALL_LINE} />
    </>
  )
}

function HowToUpdate({
  host,
  desktopInstall,
  autoUpdated,
  hostUpdater,
  overview,
}: {
  host: InstallKind
  desktopInstall: "auto" | "manual" | null
  autoUpdated: boolean
  hostUpdater: boolean
  overview: UpdatesOverview
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-separator pt-4 text-sm">
      <h3 className="font-medium">How to update this PCP</h3>
      {host === "container" && hostUpdater ? (
        <InstallerUpdate autoUpdated={autoUpdated} overview={overview} />
      ) : host === "container" && autoUpdated ? (
        <>
          <p>
            This PCP updates itself: the installer set up a daily update that
            fetches a new release and starts PCP again from it. There is nothing
            to do.
          </p>
          <p className="text-muted-foreground">
            To update at once, run the install line again:
          </p>
          <CopyableValue value={INSTALL_LINE} />
          <p className="text-muted-foreground">To turn the daily update off:</p>
          <CopyableValue value={INSTALL_MANUAL_LINE} />
        </>
      ) : host === "container" ? (
        <>
          <p className="text-muted-foreground">
            This PCP runs in a container. Updating means pulling the new image
            and starting the container again from it. Your vault is in the
            container&apos;s volume and stays.
          </p>
          <p>If you installed it with the install line, run it again:</p>
          <CopyableValue value={INSTALL_LINE} />
          <p>Or have the installer do it once a day from now on:</p>
          <CopyableValue value={INSTALL_AUTO_LINE} />
          <p>
            From a checkout with docker compose (add the same <code>-f</code>{" "}
            files you started it with):
          </p>
          <CopyableValue value={COMPOSE_LINE} />
          <p className="text-muted-foreground">
            If a deploy tool runs it (Coolify, Portainer, a NAS app), redeploy
            it there. PCP itself never pulls an image or restarts its container.
          </p>
        </>
      ) : host === "desktop" ? (
        <DesktopUpdate desktopInstall={desktopInstall} overview={overview} />
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
