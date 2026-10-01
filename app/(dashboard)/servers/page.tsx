import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { ServerList } from "@/components/server-list"
import { ButtonLink } from "@/components/ui/button"
import { listServers } from "@/lib/core/servers"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Servers" }

export default async function ServersPage() {
  const ctx = await requireContext()
  const all = await listServers(ctx)
  const servers = all.filter((server) => server.kind === "mcp")
  const endpoints = all.filter((server) => server.kind === "openapi")

  return (
    <>
      <PageHeader
        title="Servers"
        description="What an assistant can reach through PCP: MCP servers, and APIs described by an OpenAPI schema. Each is described here in your words; that description is what the assistant reads when it searches for a tool."
      />

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">MCP servers</h2>
          <ButtonLink href="/servers/new">Add a server</ButtonLink>
        </div>
        <ServerList
          servers={servers}
          empty="No servers yet. Add one, then create an API token so an assistant can use it."
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">API endpoints</h2>
          <ButtonLink href="/servers/endpoints/new">Add an endpoint</ButtonLink>
        </div>
        <ServerList
          servers={endpoints}
          empty="No API endpoints yet. Add one from an OpenAPI schema and its operations become tools an assistant can call."
        />
      </section>
    </>
  )
}
