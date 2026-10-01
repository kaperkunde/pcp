"use client"

import { useMemo, useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox, Select } from "@/components/ui/input"
import {
  decidePermissionAction,
  saveAccessRequestAction,
} from "@/lib/actions/permissions"
import type { AccessLevel } from "@/lib/core/access-requests"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  type ToolAccess,
} from "@/lib/core/constants"
import type { TokenServerAccess } from "@/lib/core/tool-access"
import { cn } from "@/lib/utils"

function keyOf(serverId: string, tool: string): string {
  return `${serverId}/${tool}`
}

function summary(levels: ToolAccess[]): string {
  return TOOL_ACCESS_LEVELS.flatMap((access) => {
    const count = levels.filter((level) => level === access).length
    return count > 0 ? [`${count} to ${TOOL_ACCESS_LABELS[access]}`] : []
  }).join(", ")
}

/**
 * The levels an assistant proposed for its token, filled in over what the
 * token has now. Every tool whose level would change is marked; the owner
 * can change any of them, and nothing is written until they save.
 */
export function AccessReview({
  id,
  servers,
  proposed,
}: {
  id: string
  servers: TokenServerAccess[]
  proposed: AccessLevel[]
}) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        proposed.map((level) => [
          keyOf(level.serverId, level.tool),
          level.access,
        ]),
      ) as Record<string, ToolAccess>,
    [proposed],
  )
  const [chosen, setChosen] = useState<Record<string, ToolAccess>>(initial)
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{
    message: string
    isError: boolean
  } | null>(null)

  const changes = servers.flatMap((server) =>
    server.tools.flatMap((tool) => {
      const access = chosen[keyOf(server.id, tool.name)] ?? tool.access
      return access !== tool.access
        ? [{ serverId: server.id, tool: tool.name, access }]
        : []
    }),
  )
  const edited = Object.entries(chosen).some(
    ([key, access]) => initial[key] !== access,
  )

  function set(keys: string[], access: ToolAccess) {
    setChosen((previous) => ({
      ...previous,
      ...Object.fromEntries(keys.map((key) => [key, access])),
    }))
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await saveAccessRequestAction(id, changes)

      if (result.status === "error") {
        setError(result.error)
      } else if (result.status === "ok") {
        // The outcome's text is written for the assistant. The page re-renders
        // as answered and says the same.
        setDone({
          message: result.isError ? result.message : "You saved these levels.",
          isError: result.isError,
        })
      }
    })
  }

  function decline() {
    setError(null)
    startTransition(async () => {
      const result = await decidePermissionAction(id, "decline")

      if (result.status === "error") {
        setError(result.error)
      } else if (result.status === "ok") {
        setDone({
          message: result.isError
            ? result.message
            : "You said no, so no tool's level changed.",
          isError: result.isError,
        })
      }
    })
  }

  if (done) {
    return (
      <p
        className={cn(
          "whitespace-pre-wrap break-words",
          done.isError && "text-destructive",
        )}
        data-testid="permission-outcome"
      >
        {done.message}
      </p>
    )
  }

  const shown = servers
    .map((server) => ({
      server,
      tools: server.tools.filter((tool) => {
        const key = keyOf(server.id, tool.name)
        return (
          !onlyChanges ||
          key in initial ||
          (chosen[key] ?? tool.access) !== tool.access
        )
      }),
    }))
    .filter((entry) => entry.tools.length > 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" data-testid="access-summary">
          {changes.length === 0
            ? "Saving now changes nothing."
            : `Saving changes ${changes.length} tool${changes.length === 1 ? "" : "s"}: ${summary(changes.map((change) => change.access))}.`}
        </p>
        <label className="flex items-center gap-2 text-muted-foreground">
          <Checkbox
            checked={onlyChanges}
            onChange={(event) => setOnlyChanges(event.target.checked)}
          />
          Only the proposed tools
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">
          None of the proposed tools are left on this token.
        </p>
      ) : (
        shown.map(({ server, tools }) => (
          <ServerLevels
            key={server.id}
            server={server}
            tools={tools}
            chosen={chosen}
            proposed={initial}
            disabled={pending}
            onChange={set}
          />
        ))
      )}
      <FormError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={save}>
          {pending ? "Working…" : "Save changes"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={decline}
        >
          Not now
        </Button>
        {edited ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setChosen(initial)}
          >
            Back to the proposal
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function ServerLevels({
  server,
  tools,
  chosen,
  proposed,
  disabled,
  onChange,
}: {
  server: TokenServerAccess
  tools: TokenServerAccess["tools"]
  chosen: Record<string, ToolAccess>
  proposed: Record<string, ToolAccess>
  disabled: boolean
  onChange: (keys: string[], access: ToolAccess) => void
}) {
  const [bulk, setBulk] = useState<ToolAccess>("ask")

  return (
    <section aria-label={server.name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{server.name}</span>
          <code className="text-xs text-muted-foreground">{server.slug}</code>
          {server.enabled ? null : (
            <Badge variant="outline">Switched off</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label={`All shown tools on ${server.slug}`}
            value={bulk}
            onChange={(event) => setBulk(event.target.value as ToolAccess)}
            className="h-8 w-auto"
          >
            <AccessOptions />
          </Select>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            onClick={() =>
              onChange(
                tools.map((tool) => keyOf(server.id, tool.name)),
                bulk,
              )
            }
            aria-label={`Set all shown tools on ${server.slug}`}
          >
            Set all shown
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {tools.map((tool) => {
          const key = keyOf(server.id, tool.name)
          const value = chosen[key] ?? tool.access
          const changed = value !== tool.access
          const asked = proposed[key]

          return (
            <li
              key={tool.name}
              data-changed={changed ? "true" : undefined}
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5",
                changed && "bg-primary/10 ring-1 ring-primary/30",
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="text-sm break-all">{tool.name}</code>
                {tool.title ? (
                  <span className="text-xs text-muted-foreground">
                    {tool.title}
                  </span>
                ) : null}
                {changed ? (
                  <Badge variant="warning">
                    Now: {TOOL_ACCESS_LABELS[tool.access]}
                  </Badge>
                ) : null}
                {asked && asked !== value ? (
                  <Badge variant="outline">
                    Proposed: {TOOL_ACCESS_LABELS[asked]}
                  </Badge>
                ) : null}
              </div>
              <Select
                aria-label={`Access to ${server.slug}/${tool.name}`}
                value={value}
                disabled={disabled}
                onChange={(event) =>
                  onChange([key], event.target.value as ToolAccess)
                }
                className={cn(
                  "h-8 w-auto",
                  value === "blocked" && "text-destructive",
                  value === "allowed" && "text-primary",
                )}
              >
                <AccessOptions />
              </Select>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function AccessOptions() {
  return TOOL_ACCESS_LEVELS.map((level) => (
    <option key={level} value={level}>
      {TOOL_ACCESS_LABELS[level]}
    </option>
  ))
}
