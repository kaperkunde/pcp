import type { Metadata } from "next"
import Link from "next/link"

import { LocalDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { ServerStatusBadge } from "@/components/server-status-badge"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { listServers } from "@/lib/core/servers"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Servers" }

export default async function ServersPage() {
  const ctx = await requireContext()
  const servers = await listServers(ctx)

  return (
    <>
      <PageHeader
        title="MCP servers"
        description="The servers an assistant can reach through PCP. Each one is described here in your words; that description is what the assistant reads when it searches for a tool."
        action={<ButtonLink href="/servers/new">Add a server</ButtonLink>}
      />

      {servers.length === 0 ? (
        <Card className="items-start">
          <p className="text-muted-foreground">
            No servers yet. Add one, then create an API token so an assistant
            can use it.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {servers.map((server) => (
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
                  <ServerStatusBadge
                    status={server.status}
                    connected={server.connected}
                    enabled={server.enabled}
                  />
                </div>
                <p className="mt-1 text-muted-foreground">
                  {server.description || "No description yet."}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {server.toolCount} tool{server.toolCount === 1 ? "" : "s"} ·{" "}
                  last checked <LocalDate value={server.lastSyncedAt} />
                  {server.statusMessage ? ` · ${server.statusMessage}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
