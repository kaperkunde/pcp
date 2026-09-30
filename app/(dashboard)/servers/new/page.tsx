import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { EMPTY_SERVER, ServerForm } from "@/components/server-form"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add a server" }

export default async function NewServerPage() {
  const ctx = await requireContext()
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <>
      <PageHeader
        title="Add a server"
        description="PCP reads the server's tool list as soon as it is added, so the next page shows what an assistant will be able to find."
      />
      <ServerForm initial={EMPTY_SERVER} secrets={secrets} />
    </>
  )
}
