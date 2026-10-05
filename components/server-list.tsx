import Link from "next/link"

import { LocalDate } from "@/components/local-date"
import { ServerStatusBadge } from "@/components/server-status-badge"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { isMailKind, type ServerSummary } from "@/lib/core/servers"

/** The cards on the Servers page: servers, endpoints and mail accounts. */
export function ServerList({
  servers,
  empty,
}: {
  servers: ServerSummary[]
  empty: string
}) {
  if (servers.length === 0) {
    return (
      <Card className="items-start">
        <p className="text-muted-foreground">{empty}</p>
      </Card>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {servers.map((server) => {
        const endpoint = server.kind === "openapi"
        const mail = isMailKind(server.kind)
        const noun = endpoint ? "operation" : "tool"

        return (
          <li key={server.id}>
            <Link
              href={`/servers/${server.id}`}
              className="block rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:ring-primary/50"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-base font-medium">{server.name}</span>
                  <code className="text-xs text-muted-foreground">
                    {server.slug}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  {(endpoint || mail) && server.readOnly ? (
                    <Badge variant="outline">Read-only</Badge>
                  ) : null}
                  <ServerStatusBadge
                    status={server.status}
                    connected={server.connected}
                    enabled={server.enabled}
                    kind={server.kind}
                    oauth={server.authType === "oauth"}
                  />
                </div>
              </div>
              <p className="mt-1 text-muted-foreground">
                {server.description || "No description yet."}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {server.toolCount} {noun}
                {server.toolCount === 1 ? "" : "s"} ·{" "}
                {endpoint ? "schema read" : "last checked"}{" "}
                <LocalDate value={server.lastSyncedAt} />
                {server.statusMessage ? ` · ${server.statusMessage}` : ""}
              </p>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
