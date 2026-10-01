import type { Metadata } from "next"

import { EMPTY_ENDPOINT, EndpointForm } from "@/components/endpoint-form"
import { PageHeader } from "@/components/page-header"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add an endpoint" }

export default async function NewEndpointPage() {
  const ctx = await requireContext()
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <>
      <PageHeader
        title="Add an endpoint"
        description="PCP reads the OpenAPI schema as soon as it is added and turns each operation into a tool. When an assistant calls one, PCP sends the request straight to the API with the secret you choose."
      />
      <EndpointForm initial={EMPTY_ENDPOINT} secrets={secrets} />
    </>
  )
}
