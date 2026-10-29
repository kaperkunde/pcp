"use client"

import { useEffect, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/input"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  removeServiceAction,
  runServiceActionAction,
  serviceLogsAction,
  serviceStatusAction,
  updateServiceAction,
} from "@/lib/actions/services"
import type { ServiceStatus, ServiceView } from "@/lib/core/services/services"

/**
 * A service's own section on its page: where it runs, what it runs and
 * serves, how it is now (read on its SSH server when the page opens, and
 * again on Check), its recent lines, and starting, stopping, restarting and
 * updating it. Nothing here is secret: variables show the secret's name.
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
                        `Stop ${view.name}? The tools it serves answer that it is stopped until it is started again.`,
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
          description={`${view.containerName}, with ${view.engine === "podman" ? "Podman" : "Docker"}${view.engineVersion ? ` ${view.engineVersion}` : ""}${publish ? `; published on ${publish}` : ""}.`}
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
        <ListRow
          title="Image"
          description={
            <span className="block font-mono text-xs break-all">
              {view.definition.image}
            </span>
          }
          trailing={
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                act(
                  view.definition.source
                    ? `Update ${view.name}? PCP pulls the newest ${view.definition.source}, pins its digest and makes the container again. Its data stays.`
                    : `Make ${view.name}'s container again from its image? Its data stays.`,
                  () => updateServiceAction(view.id),
                )
              }
            >
              {view.definition.source ? "Update" : "Recreate"}
            </Button>
          }
        />
        {view.registered ? (
          <ListRow
            href={`/servers/${view.registered.id}`}
            title="Serves"
            description={`${view.registered.name} (${view.registered.slug}), ${view.registered.kind === "openapi" ? "an API endpoint" : "an MCP server"}: the service's own tools are there.`}
          />
        ) : null}
        {view.env.length > 0 ? (
          <ListRow
            title="Variables"
            description={view.env
              .map(
                (entry) =>
                  `${entry.name}: ${entry.secretName ?? "its fixed value or none"}`,
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
