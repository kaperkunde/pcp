"use client"

import { useEffect, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Checkbox, Input } from "@/components/ui/input"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  checkServiceImageAction,
  removeServiceAction,
  runServiceActionAction,
  serviceLogsAction,
  serviceStatusAction,
  updateServiceAction,
} from "@/lib/actions/services"
import type { ServiceStatus, ServiceView } from "@/lib/core/services/services"
import type { NewerImage } from "@/lib/core/services/updates"

/**
 * A service's own section on its page: where it runs, what it runs and
 * serves, how it is now (read on its SSH server when the page opens, and
 * again on Check), its recent lines, and starting, stopping, restarting and
 * updating it. Nothing here is secret: variables show the secret's name.
 * A Podman service also says how to have it start again with its machine.
 */
export function ServiceCard({ view }: { view: ServiceView }) {
  const [pending, startTransition] = useTransition()
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [result, setResult] = useState<ServerActionResult>({ status: "idle" })
  const [logs, setLogs] = useState<string | null>(null)

  function check() {
    startTransition(async () => {
      const read = await serviceStatusAction(view.id)
      if (read.status === "ok") {
        setStatus(read.service)
        setStatusError(null)
      } else if (read.status === "error") {
        setStatusError(read.error)
      }
    })
  }

  // Read once when the page opens: inside this request, never on a timer.
  useEffect(check, [view.id])

  function act(
    question: string | null,
    action: () => Promise<ServerActionResult>,
  ) {
    if (question && !window.confirm(question)) {
      return
    }

    startTransition(async () => {
      setResult(await action())
      const read = await serviceStatusAction(view.id)
      if (read.status === "ok") {
        setStatus(read.service)
      }
    })
  }

  function showLogs() {
    startTransition(async () => {
      const read = await serviceLogsAction(view.id, 100)
      if (read.status === "ok") {
        setLogs(read.text.trim() || "Nothing written yet.")
      } else if (read.status === "error") {
        setResult(read)
      }
    })
  }

  const running = status?.state === "running"
  const publish = view.publish.ports
    .map((port) => `${view.publish.address}:${port.host} → ${port.container}`)
    .join(", ")

  return (
    <ListSection
      title="Service"
      description="A container PCP runs with the engine already on your SSH server, through its command line over SSH. PCP reads how it is when you open this page."
      action={
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={check}
        >
          {pending ? "Checking…" : "Check"}
        </Button>
      }
      data-testid="service-card"
    >
      <List>
        <ListRow
          title="Now"
          description={
            statusError ? (
              <span className="text-destructive">{statusError}</span>
            ) : status ? (
              <StatusLine status={status} />
            ) : (
              "Reading…"
            )
          }
          trailing={
            <div className="flex flex-wrap justify-end gap-2">
              {running ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      act(null, () =>
                        runServiceActionAction(view.id, "restart"),
                      )
                    }
                  >
                    Restart
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      act(
                        `Stop ${view.name}? The tools it serves answer that it is stopped until it is started again: PCP does not start it by itself while you leave it stopped.`,
                        () => runServiceActionAction(view.id, "stop"),
                      )
                    }
                  >
                    Stop
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={pending || !status}
                  onClick={() =>
                    act(null, () => runServiceActionAction(view.id, "start"))
                  }
                >
                  Start
                </Button>
              )}
            </div>
          }
        />
        <ListRow
          title="Runs on"
          description={`${view.containerName}, with ${view.engine === "podman" ? "Podman" : "Docker"}${view.engineVersion ? ` ${view.engineVersion}` : ""}${publish ? `; published on ${publish}` : ""}. ${reachWords(view)}`}
          trailing={
            view.host ? (
              <a
                className="text-sm text-primary underline-offset-4 hover:underline"
                href={`/servers/${view.host.id}`}
              >
                {view.host.name}
              </a>
            ) : (
              <RowValue>Its SSH server was removed</RowValue>
            )
          }
        />
        <ImageRow view={view} pending={pending} act={act} />
        {view.engine === "podman" && view.host ? (
          <ListRow
            title="When the SSH server restarts"
            description={<PodmanRestartHint view={view} />}
            data-testid="podman-restart-hint"
          />
        ) : null}
        {view.definitionId ? (
          <ListRow
            href={`/servers/services/new?definition=${encodeURIComponent(view.definitionId)}`}
            title="Launch another"
            description="Another container of this definition, on an SSH server, address and secrets of its own. A change to the definition is every one's."
          />
        ) : null}
        {view.registered ? (
          <ListRow
            href={`/servers/${view.registered.id}`}
            title="Serves"
            description={`${view.registered.name} (${view.registered.slug}), ${view.registered.kind === "openapi" ? "an API endpoint" : "an MCP server"}: the service's own tools are there.`}
          />
        ) : null}
        {view.exit && view.host ? (
          <ListRow
            href={`/servers/${view.host.id}`}
            title="Exit"
            description={`${view.exit.name}${view.exit.label ? ` (${view.exit.label})` : ""}: web fetch and the browser go out through this VPN for the tokens you allow. Its proxy listens on ${view.host.name}'s 127.0.0.1 only${view.definition.cap_add.length > 0 || view.definition.devices.length > 0 ? `; the container has ${[...view.definition.cap_add, ...view.definition.devices].join(" and ")}` : ""}. Removing the service removes the exit.`}
          />
        ) : null}
        {view.env.length > 0 ? (
          <ListRow
            title="Variables"
            description={view.env
              .map(
                (entry) =>
                  `${entry.name}: ${entry.secretName ?? entry.value ?? "its fixed value or none"}`,
              )
              .join(" · ")}
          />
        ) : null}
        <div data-slot="list-row" className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px] leading-snug">Recent lines</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={showLogs}
            >
              {logs === null ? "Show" : "Read again"}
            </Button>
          </div>
          {logs !== null ? (
            <pre className="max-h-80 overflow-auto rounded-lg bg-secondary p-3 text-xs leading-relaxed whitespace-pre-wrap">
              {logs}
            </pre>
          ) : null}
        </div>
      </List>
      <FormError
        className="px-1"
        error={result.status === "error" ? result.error : null}
      />
      <FormNote
        className="px-1"
        message={result.status === "ok" ? result.message : null}
      />
    </ListSection>
  )
}

/**
 * What it runs, and updating it: for an image it pulls, a look for a newer
 * one of its source (on your click only, never on a timer) and Update; for
 * one built from a repository, the commit it was built from and a new one
 * to build.
 */
function ImageRow({
  view,
  pending,
  act,
}: {
  view: ServiceView
  pending: boolean
  act: (
    question: string | null,
    action: () => Promise<ServerActionResult>,
  ) => void
}) {
  const [checking, startChecking] = useTransition()
  const [newer, setNewer] = useState<NewerImage | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const build = view.definition.build
  const [commit, setCommit] = useState(build?.commit ?? "")
  const mono = "block font-mono text-xs break-all"

  function lookForNewer() {
    startChecking(async () => {
      const read = await checkServiceImageAction(view.id)
      if (read.status === "ok") {
        setNewer(read.image)
        setCheckError(null)
      } else if (read.status === "error") {
        setCheckError(read.error)
      }
    })
  }

  if (build) {
    return (
      <div
        data-slot="list-row"
        className="flex flex-col gap-2 px-4 py-3"
        data-testid="service-build"
      >
        <span className="text-[15px] leading-snug">Image</span>
        <span className="text-sm leading-relaxed text-muted-foreground">
          Built on its SSH server from{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={`https://github.com/${build.repository}/tree/${build.commit}`}
            rel="noreferrer"
            target="_blank"
          >
            {build.repository}
          </a>{" "}
          at {build.commit.slice(0, 12)}, with {build.containerfile}
          {build.context !== "." ? ` in ${build.context}` : ""}. It is never
          pulled: a new commit is built there.
        </span>
        {view.definition.image ? (
          <span className={mono}>{view.definition.image}</span>
        ) : null}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            act(
              commit.trim() === build.commit
                ? `Make ${view.name}'s container again from the image built at ${build.commit.slice(0, 12)}? Its data stays.`
                : `Build ${build.repository} at ${commit.trim().slice(0, 12)} on its SSH server and make ${view.name}'s container again from it? Its data stays.`,
              () => updateServiceAction(view.id, commit),
            )
          }}
        >
          <Input
            aria-label="Commit to build"
            value={commit}
            onChange={(event) => setCommit(event.target.value)}
            className="min-w-0 flex-1 font-mono text-xs"
            spellCheck={false}
            pattern="[a-f0-9]{40}"
            title="The commit's full id: 40 hex digits."
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={pending}
          >
            {commit.trim() === build.commit ? "Recreate" : "Build and update"}
          </Button>
        </form>
      </div>
    )
  }

  return (
    <ListRow
      title="Image"
      description={
        <>
          <span className={mono}>{view.definition.image}</span>
          {checkError ? (
            <span className="mt-1 block text-destructive">{checkError}</span>
          ) : newer ? (
            <span className="mt-1 block" data-testid="newer-image">
              {newer.newer ? (
                <>
                  A newer image of {newer.source}:{" "}
                  <span className={mono}>{newer.newest}</span>
                  Update pins it and makes the container again.
                </>
              ) : (
                `It runs the newest ${newer.source}.`
              )}
            </span>
          ) : null}
        </>
      }
      trailing={
        <div className="flex flex-wrap justify-end gap-2">
          {view.definition.source ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending || checking}
              onClick={lookForNewer}
            >
              {checking ? "Looking…" : "Check for a newer image"}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              act(
                view.definition.source
                  ? `Update ${view.name}? PCP pulls the newest ${view.definition.source}, pins its digest and makes the container again. Its data stays.`
                  : `Make ${view.name}'s container again from its image? Its data stays.`,
                async () => {
                  const done = await updateServiceAction(view.id)
                  setNewer(null)
                  return done
                },
              )
            }
          >
            {view.definition.source ? "Update" : "Recreate"}
          </Button>
        </div>
      }
    />
  )
}

/** How PCP reaches it, and what it does when it finds it stopped. */
function reachWords(view: ServiceView): string {
  const how =
    view.reach === "tunnel"
      ? "PCP reaches it through the SSH connection."
      : `PCP reaches it from its own machine at the published address, and through the SSH connection once you ${view.definition.source || view.definition.build ? "update" : "recreate"} it.`
  const stopped =
    view.intent === "stopped"
      ? " It was stopped through PCP, so PCP leaves it stopped until it is started again."
      : " While you leave it running, PCP starts it again when a call finds it stopped, and when you or an assistant next use PCP."

  return `${how}${stopped}`
}

/**
 * Podman starts no container when its machine starts unless its restart
 * unit is enabled (or the container has a Quadlet unit of its own): for the
 * system's containers as root, or the login's own with lingering.
 */
function PodmanRestartHint({ view }: { view: ServiceView }) {
  const user = view.host?.username ?? ""
  const root = user === "root"
  const code = "rounded bg-secondary px-1 py-0.5 font-mono text-xs"

  return (
    <span className="leading-relaxed">
      Podman starts its containers again after a restart only when its restart
      unit is enabled. On {view.host?.name}, as {user || "the login PCP uses"}:{" "}
      {root ? (
        <code className={code}>systemctl enable podman-restart.service</code>
      ) : (
        <>
          <code className={code}>
            systemctl --user enable podman-restart.service
          </code>{" "}
          and{" "}
          <code className={code}>
            loginctl enable-linger {user || "<login>"}
          </code>
          , so its user services run without a session
        </>
      )}
      . A Quadlet unit for {view.containerName} does the same for this container
      alone. Until then PCP starts it again when a call needs it, or when PCP is
      next used.
    </span>
  )
}

function StatusLine({ status }: { status: ServiceStatus }) {
  if (status.foreign) {
    return (
      <span className="text-destructive">
        The container with its name is not the one PCP started.
      </span>
    )
  }

  if (status.state === "missing") {
    return (
      <span className="text-destructive">
        Its container is gone: Start makes it again.
      </span>
    )
  }

  if (status.state !== "running") {
    return (
      <span className="text-warning">
        Stopped
        {status.exitCode !== null
          ? ` (it exited with code ${status.exitCode})`
          : ""}
        .
      </span>
    )
  }

  return (
    <span>
      Running
      {status.health === "healthy"
        ? " and healthy"
        : status.health === "unhealthy"
          ? `, but unhealthy: ${status.detail ?? "its health check fails"}`
          : status.health === "starting"
            ? ", still starting"
            : ""}
      {status.startedAt ? (
        <>
          , since <LocalDate value={new Date(status.startedAt)} />
        </>
      ) : null}
      .
      {status.upToDate
        ? ""
        : " It runs an older image than its definition names: Update."}
    </span>
  )
}

/**
 * Last on a service's page: removing it takes its container off the SSH
 * server first, and, as chosen, its volumes and the server it serves.
 */
export function ServiceRemove({
  serviceId,
  name,
}: {
  serviceId: string
  name: string
}) {
  const [volumes, setVolumes] = useState(false)
  const [registered, setRegistered] = useState(true)
  const [result, setResult] = useState<ServerActionResult>({ status: "idle" })

  return (
    <div className="flex flex-col items-center gap-2 pt-2 text-center">
      <form
        action={async () => {
          setResult(
            await removeServiceAction(serviceId, { volumes, registered }),
          )
        }}
        onSubmit={(event) => {
          if (
            !window.confirm(
              `Remove ${name}? PCP removes its container from the SSH server${volumes ? ", with its data" : ""}.`,
            )
          ) {
            event.preventDefault()
          }
        }}
        className="flex flex-col items-center gap-2"
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={registered}
            onChange={(event) => setRegistered(event.target.checked)}
          />
          Remove the server it serves too
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={volumes}
            onChange={(event) => setVolumes(event.target.checked)}
          />
          Delete its volumes (its data) too
        </label>
        <SubmitButton variant="destructive" pendingText="Removing…">
          Remove {name}
        </SubmitButton>
      </form>
      <FormError error={result.status === "error" ? result.error : null} />
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        Removes the container from the SSH server and the service from PCP.
        Secrets you chose for it stay.
      </p>
    </div>
  )
}
