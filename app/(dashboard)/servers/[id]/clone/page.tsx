import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { CloneForm } from "@/components/clone-form"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
} from "@/lib/core/constants"
import { canClone, definitionOf } from "@/lib/core/definitions"
import { isPcpError } from "@/lib/core/errors"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { listSecrets } from "@/lib/core/secrets"
import { extraAuthHeaders, getServer } from "@/lib/core/servers"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Clone" }

/**
 * Another server of the same definition: asks only for what is the new
 * one's own, and copies the levels from this one.
 */
export default async function ClonePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  let server: Awaited<ReturnType<typeof getServer>>

  try {
    server = await getServer(ctx, id)
  } catch (error) {
    if (isPcpError(error) && error.code === "not_found") {
      notFound()
    }

    throw error
  }

  if (!canClone(server.kind)) {
    notFound()
  }

  const definition = await definitionOf(ctx, server.id)
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))
  const authType =
    server.authType === "header" ||
    server.authType === "basic" ||
    server.authType === "oauth"
      ? server.authType
      : "none"

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: `/servers/${server.id}`, label: server.name }}
        title={`Clone ${server.name}`}
        description={
          <>
            Another {server.kind === "openapi" ? "API endpoint" : "MCP server"}{" "}
            of the definition{" "}
            <code className="text-sm">{definition?.slug ?? server.slug}</code>:
            the same description
            {server.kind === "openapi" ? ", schema and edits" : ""} and tool
            descriptions, with its own address, secret and note. It starts with
            this one&apos;s levels; tokens limited to some servers reach it once
            you add it to them.
          </>
        }
      />
      <CloneForm
        source={{
          id: server.id,
          kind: server.kind === "openapi" ? "openapi" : "mcp",
          name: server.name,
          authType,
          authUsername: server.authUsername ?? "",
          authHeaderName: server.authHeaderName ?? DEFAULT_HEADER_NAME,
          authValueTemplate: server.authValueTemplate ?? DEFAULT_VALUE_TEMPLATE,
          authExtraHeaders: (await extraAuthHeaders(server.id)).map(
            (header) => ({
              secretId: "",
              headerName: header.headerName,
              valueTemplate: header.valueTemplate,
            }),
          ),
          oauthScope: server.oauthScope ?? "",
        }}
        secrets={secrets}
        redirectUrl={oauthRedirectUrl(await publicUrlFor(ctx))}
      />
    </PageColumn>
  )
}
