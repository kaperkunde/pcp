"use client"

import { useState } from "react"

import { ChoiceCard } from "@/components/assistant-choice"
import { IconTile, serverKindLabel } from "@/components/ui/icon-tile"
import { Checkbox } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import type { ServerKind } from "@/lib/core/servers"
import { cn } from "@/lib/utils"

type Scope = "all" | "selected"

type ScopeServer = { id: string; name: string; kind?: ServerKind }

/**
 * Which servers a token reaches: all of them, or the ones ticked. Submits as
 * `access` ("all" or "selected") and one `serverIds` per ticked server.
 *
 * `choices` (the default) is two cards side by side with the servers under
 * them, for a form of its own (connecting an assistant, an app signing in);
 * `rows` sits inside a List on the assistant's page.
 */
export function ServerScopeFields({
  servers,
  allowAll = true,
  selected = [],
  variant = "choices",
  disabled = false,
}: {
  servers: ScopeServer[]
  allowAll?: boolean
  selected?: string[]
  variant?: "choices" | "rows"
  disabled?: boolean
}) {
  const [scope, setScope] = useState<Scope>(allowAll ? "all" : "selected")

  if (variant === "rows") {
    return (
      <>
        <div className="flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
            <span className="text-[15px] leading-snug">Servers</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {scope === "all"
                ? "Every server, including ones you add later."
                : "Only the servers ticked below."}
            </span>
          </div>
          <SegmentedControl<Scope>
            name="access"
            legend="Servers it reaches"
            value={scope}
            onValueChange={setScope}
            disabled={disabled}
            options={[
              { value: "all", label: "All servers" },
              { value: "selected", label: "Only some" },
            ]}
          />
        </div>
        {scope === "selected" ? (
          <ServerChecklist
            servers={servers}
            selected={selected}
            disabled={disabled}
            rowClassName="pl-6"
          />
        ) : null}
      </>
    )
  }

  return (
    <fieldset disabled={disabled} className="m-0 flex flex-col gap-2">
      <legend className="mb-2 text-[13px] font-semibold text-muted-foreground">
        What it can reach
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <ChoiceCard
          name="access"
          value="all"
          checked={scope === "all"}
          onChoose={() => setScope("all")}
          title="All servers"
          caption="Every server, including ones you add later"
        />
        <ChoiceCard
          name="access"
          value="selected"
          checked={scope === "selected"}
          onChoose={() => setScope("selected")}
          title="Only some"
          caption="Only the servers you tick"
        />
      </div>
      {scope === "selected" ? (
        <div className="overflow-hidden rounded-xl border border-separator bg-field">
          <ServerChecklist servers={servers} selected={selected} />
        </div>
      ) : null}
    </fieldset>
  )
}

/** One row per server, ticked when the token reaches it. */
function ServerChecklist({
  servers,
  selected,
  disabled,
  rowClassName,
}: {
  servers: ScopeServer[]
  selected: string[]
  disabled?: boolean
  rowClassName?: string
}) {
  if (servers.length === 0) {
    return (
      <p
        className={cn(
          "px-4 py-3 text-[13px] text-muted-foreground",
          rowClassName,
        )}
      >
        No servers to choose from yet.
      </p>
    )
  }

  return (
    <div className="flex flex-col divide-y divide-separator">
      {servers.map((server) => (
        <label
          key={server.id}
          className={cn(
            "flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2",
            rowClassName,
          )}
        >
          <IconTile kind={server.kind ?? "mcp"} size="sm" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{server.name}</span>
            <span className="text-xs text-muted-foreground">
              {serverKindLabel(server.kind ?? "mcp")}
            </span>
          </span>
          <Checkbox
            name="serverIds"
            value={server.id}
            defaultChecked={selected.includes(server.id)}
            disabled={disabled}
          />
        </label>
      ))}
    </div>
  )
}
