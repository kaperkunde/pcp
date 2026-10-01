import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { TokenManager } from "@/components/token-manager"
import { listApiTokens } from "@/lib/core/api-tokens"
import { listServers } from "@/lib/core/servers"
import { getVault } from "@/lib/core/vault"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "API tokens" }

export default async function TokensPage() {
  const ctx = await requireContext()
  const [tokens, servers, vault] = await Promise.all([
    listApiTokens(ctx),
    listServers(ctx),
    getVault(ctx.vaultId),
  ])

  return (
    <>
      <PageHeader
        title="API tokens"
        description="What an assistant presents to the gateway. Each token can reach every server and endpoint, or a chosen few."
      />
      <TokenManager
        tokens={tokens}
        servers={servers.map(({ id, name, kind }) => ({ id, name, kind }))}
        username={vault.name}
      />
    </>
  )
}
