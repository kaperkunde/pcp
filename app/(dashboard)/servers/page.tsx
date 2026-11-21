import type { Metadata } from "next"

import { GetStarted } from "@/components/get-started"
import { PageHeader } from "@kaperkunde/ui/page"
import { ServerAddMenu } from "@/components/server-add-menu"
import { ServerAlerts } from "@/components/server-alerts"
import { ServerList } from "@/components/server-list"
import { ListSection } from "@kaperkunde/ui/list"
import { listApiTokens } from "@/lib/core/api-tokens"
import { listServers } from "@/lib/core/servers"
import { flowWrapperIds } from "@/lib/core/wrappers/definition"
import { requireContext } from "@/lib/server/session"
import { ensureOwnStore } from "@/lib/core/storage/roots"

export const metadata: Metadata = { title: "Servers" }

export default async function ServersPage() {
  const ctx = await requireContext()
  // PCP's own store is always there, for a vault from before it too.
  const ownStore = await ensureOwnStore(ctx)
  const [servers, tokens, flows] = await Promise.all([
    listServers(ctx),
    listApiTokens(ctx),
    flowWrapperIds(ctx),
  ])
  // Only what PCP comes with (its own store, the browser): an assistant
  // can set up the rest when asked.
  const onlyOwn = servers.every(
    (server) => server.id === ownStore || server.kind === "browser",
  )
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

      <ServerAlerts
        alerts={servers
          .filter(
            (server) =>
              server.statusMessage &&
              (server.status === "auth_required" ||
                server.status === "refused" ||
                server.status === "error"),
          )
          .map((server) => ({
            id: server.id,
            name: server.name,
            message: server.statusMessage,
            seenAt: server.statusAt,
            // Signing in again is the owner's, on the server's page.
            clearable: !(
              server.status === "auth_required" && server.authType === "oauth"
            ),
          }))}
      />

      {onlyOwn ? <GetStarted hasToken={hasToken} /> : null}

      {servers.length === 0 ? null : (
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
              flow: flows.has(server.id),
            }))}
          />
        </ListSection>
      )}
    </>
  )
}
