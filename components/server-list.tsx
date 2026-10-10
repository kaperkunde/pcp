"use client"

import { useState } from "react"

import { ServerStatusBadge } from "@/components/server-status-badge"
import { Badge } from "@/components/ui/badge"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow } from "@/components/ui/list"
import { SegmentedControl } from "@/components/ui/segmented-control"
import type { ServerKind, ServerSummary } from "@/lib/core/servers"

export type ServerListItem = Pick<
  ServerSummary,
  | "id"
  | "kind"
  | "name"
  | "slug"
  | "description"
  | "enabled"
  | "readOnly"
  | "authType"
  | "status"
  | "connected"
  | "toolCount"
>

type Filter = "all" | "mcp" | "api" | "mail" | "ssh" | "wrapper" | "browser"

const FILTERS: Array<{
  value: Exclude<Filter, "all">
  label: string
  kinds: ServerKind[]
}> = [
  { value: "mcp", label: "MCP", kinds: ["mcp"] },
  { value: "api", label: "APIs", kinds: ["openapi"] },
  { value: "mail", label: "Mail", kinds: ["jmap", "imap"] },
  { value: "ssh", label: "SSH", kinds: ["ssh"] },
  { value: "wrapper", label: "Wrappers", kinds: ["wrapper"] },
  { value: "browser", label: "Browser", kinds: ["browser"] },
]

/**
 * Every server on one list, whatever its kind: the kind's tile, the name,
 * its description on one grey line, and how it is at the right. With more
 * than one kind, a filter above narrows it to one.
 */
export function ServerList({ servers }: { servers: ServerListItem[] }) {
  const [filter, setFilter] = useState<Filter>("all")
  const present = FILTERS.map((option) => ({
    ...option,
    count: servers.filter((server) => option.kinds.includes(server.kind))
      .length,
  })).filter((option) => option.count > 0)
  const chosen = present.find((option) => option.value === filter)
  const shown = chosen
    ? servers.filter((server) => chosen.kinds.includes(server.kind))
    : servers

  return (
    <div className="flex flex-col gap-4">
      {present.length > 1 ? (
        <SegmentedControl<Filter>
          name="server-kind"
          legend="Show"
          className="self-start"
          value={chosen ? filter : "all"}
          onValueChange={setFilter}
          options={[
            {
              value: "all",
              label: <Count label="All" count={servers.length} />,
            },
            ...present.map((option) => ({
              value: option.value,
              label: <Count label={option.label} count={option.count} />,
            })),
          ]}
        />
      ) : null}
      <List as="ul" aria-label="Servers">
        {shown.map((server) => (
          <ServerRow key={server.id} server={server} />
        ))}
      </List>
    </div>
  )
}

function Count({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="text-xs text-muted-foreground">{count}</span>
    </>
  )
}

function ServerRow({ server }: { server: ServerListItem }) {
  const readOnly =
    server.readOnly &&
    (server.kind === "openapi" ||
      server.kind === "jmap" ||
      server.kind === "imap")

  return (
    <ListRow
      as="li"
      href={`/servers/${server.id}`}
      className="min-h-16"
      icon={<IconTile kind={server.kind} />}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-semibold">{server.name}</span>
          {readOnly ? <Badge variant="secondary">Read-only</Badge> : null}
          <code className="text-xs font-normal text-muted-foreground">
            {server.slug}
          </code>
        </span>
      }
      description={
        <span className="block truncate">
          {server.description || "No description yet."}
        </span>
      }
      trailing={
        <span className="flex shrink-0 flex-col items-end gap-1">
          <ServerStatusBadge
            status={server.status}
            connected={server.connected}
            enabled={server.enabled}
            kind={server.kind}
            oauth={server.authType === "oauth"}
          />
          <span className="text-xs text-muted-foreground">
            {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
          </span>
        </span>
      }
    />
  )
}
