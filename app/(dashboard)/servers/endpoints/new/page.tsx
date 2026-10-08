import type { Metadata } from "next"

import { EMPTY_ENDPOINT, EndpointForm } from "@/components/endpoint-form"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { IconTile } from "@/components/ui/icon-tile"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { listSecrets } from "@/lib/core/secrets"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add an API endpoint" }

export default async function NewEndpointPage() {
  const ctx = await requireContext()
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="openapi" size="lg" />}
        title="Add an API endpoint"
        description="Point PCP at the API's OpenAPI schema: it reads it as soon as it is added and turns each operation into a tool. When an assistant calls one, PCP sends the request straight to the API with the secret you choose, or the token from signing in."
      />
      <EndpointForm
        initial={EMPTY_ENDPOINT}
        secrets={secrets}
        redirectUrl={oauthRedirectUrl(await publicUrlFor(ctx))}
      />
    </PageColumn>
  )
}
