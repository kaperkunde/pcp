import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { SecretAddDialog } from "@/components/secret-add-dialog"
import { SecretsManager } from "@/components/secrets-manager"
import {
  listBrowserOrigins,
  listSecretAllowances,
} from "@/lib/core/browser-secrets"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Secrets" }

export default async function SecretsPage() {
  const ctx = await requireContext()
  const [secrets, origins, allowances] = await Promise.all([
    listSecrets(ctx),
    listBrowserOrigins(ctx),
    listSecretAllowances(ctx),
  ])

  return (
    <>
      <PageHeader
        title="Secrets"
        description="The credentials PCP sends to your servers and APIs, and types into pages in its browser where you allow it. They never reach an assistant: PCP puts each one in place itself."
        action={<SecretAddDialog />}
      />
      <SecretsManager
        secrets={secrets.map((secret) => ({
          ...secret,
          browserOrigins: origins.get(secret.id) ?? [],
          allowances: allowances
            .filter((allowance) => allowance.secretId === secret.id)
            .map((allowance) => ({
              tokenId: allowance.tokenId,
              tokenName: allowance.tokenName,
              origin: allowance.origin,
              until: allowance.until?.toISOString() ?? null,
              once: allowance.once,
            })),
        }))}
      />
    </>
  )
}
