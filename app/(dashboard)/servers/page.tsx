import type { Metadata } from "next"

import { GetStarted } from "@/components/get-started"
import { PageHeader } from "@/components/page-header"
import { ServerAddMenu } from "@/components/server-add-menu"
import { ServerList } from "@/components/server-list"
import { ListSection } from "@/components/ui/list"
import { listApiTokens } from "@/lib/core/api-tokens"
import { listServers } from "@/lib/core/servers"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Servers" }

export default async function ServersPage() {
  const ctx = await requireContext()
  const [servers, tokens] = await Promise.all([
    listServers(ctx),
    listApiTokens(ctx),
  ])
  const now = new Date()
  const hasToken = tokens.some(
    (token) => !token.revokedAt && (!token.expiresAt || token.expiresAt > now),
  )

  return (
    <>
      <PageHeader
        title="Servers"
        description="Everything an assistant can reach through PCP."
        action={
          <ServerAddMenu
            hasBrowser={servers.some((server) => server.kind === "browser")}
          />
        }
      />

      {servers.length === 0 ? (
        <GetStarted hasToken={hasToken} />
      ) : (
        <ListSection footer="Each is described in your words: that description is what an assistant reads when it searches for a tool.">
          <ServerList
            servers={servers.map((server) => ({
              id: server.id,
              kind: server.kind,
              name: server.name,
              slug: server.slug,
              description: server.description,
              enabled: server.enabled,
              readOnly: server.readOnly,
              authType: server.authType,
              status: server.status,
              connected: server.connected,
              toolCount: server.toolCount,
            }))}
          />
        </ListSection>
      )}
    </>
  )
}
