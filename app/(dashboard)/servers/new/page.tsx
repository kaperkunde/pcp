import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { EMPTY_SERVER, ServerForm } from "@/components/server-form"
import { IconTile } from "@/components/ui/icon-tile"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { listSecrets } from "@/lib/core/secrets"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add an MCP server" }

export default async function NewServerPage() {
  const ctx = await requireContext()
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="mcp" size="lg" />}
        title="Add an MCP server"
        description="By its address. PCP reads the server's tool list as soon as it is added, so the next page shows what an assistant will be able to find."
      />
      <ServerForm
        initial={EMPTY_SERVER}
        secrets={secrets}
        redirectUrl={oauthRedirectUrl(await publicUrlFor(ctx))}
      />
    </PageColumn>
  )
}
