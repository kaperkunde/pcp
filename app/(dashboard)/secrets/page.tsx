import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { SecretsManager } from "@/components/secrets-manager"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Secrets" }

export default async function SecretsPage() {
  const ctx = await requireContext()
  const secrets = await listSecrets(ctx)

  return (
    <>
      <PageHeader
        title="Secrets"
        description="The credentials PCP sends to your MCP servers. They never reach an assistant: the gateway adds them to each upstream call itself."
      />
      <SecretsManager secrets={secrets} />
    </>
  )
}
