import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { ServiceLaunchForm } from "@/components/service-form"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { IconTile } from "@/components/ui/icon-tile"
import { db } from "@/lib/core/db"
import { listSecrets } from "@/lib/core/secrets"
import { sshServerView } from "@/lib/core/ssh/hosts"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Launch a service" }

export default async function NewServicePage() {
  const ctx = await requireContext()
  const hosts = (
    await db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId, kind: "ssh" },
      orderBy: { name: "asc" },
    })
  )
    // A service's commands go only to a server whose host key is pinned.
    .filter((server) => server.sshHostKey)
    .map((server) => ({
      id: server.id,
      name: server.name,
      address: sshServerView(server).host,
    }))
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="service" size="lg" />}
        title="Launch a service"
        description="PCP runs a container on one of your SSH servers with the Docker or Podman already there, and adds what it serves as an API endpoint or MCP server in the same step. Its secrets come from your vault; assistants never see them."
      />
      {hosts.length > 0 ? (
        <ServiceLaunchForm hosts={hosts} secrets={secrets} />
      ) : (
        <Card className="items-start gap-3 p-5 text-sm leading-relaxed sm:p-6">
          <p>
            A service runs on one of your SSH servers. Add one first, and check
            its sign-in so PCP pins its host key.
          </p>
          <ButtonLink href="/servers/ssh/new">Add an SSH server</ButtonLink>
        </Card>
      )}
    </PageColumn>
  )
}
