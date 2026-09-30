import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PageHeader } from "@/components/page-header"
import { ServerDetail } from "@/components/server-detail"
import { ServerForm } from "@/components/server-form"
import { isPcpError } from "@/lib/core/errors"
import { listSecrets } from "@/lib/core/secrets"
import { getServer, type AuthType, type ServerStatus } from "@/lib/core/servers"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Server" }

export default async function ServerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const query = await searchParams

  let server: Awaited<ReturnType<typeof getServer>>

  try {
    server = await getServer(ctx, id)
  } catch (error) {
    if (isPcpError(error) && error.code === "not_found") {
      notFound()
    }

    throw error
  }

  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  const notice =
    typeof query.error === "string"
      ? { kind: "error" as const, message: query.error }
      : query.connected
        ? { kind: "ok" as const, message: `Connected to ${server.name}.` }
        : null

  return (
    <>
      <PageHeader
        title={server.name}
        description={server.description || "No description yet."}
      />
      <ServerDetail
        server={{
          id: server.id,
          name: server.name,
          slug: server.slug,
          url: server.url,
          enabled: server.enabled,
          authType: server.authType as AuthType,
          status: server.status as ServerStatus,
          statusMessage: server.statusMessage,
          connected:
            server.authType !== "oauth" || server.oauthConnectedAt !== null,
          lastSyncedAt: server.lastSyncedAt,
        }}
        tools={server.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          descriptionOverride: tool.descriptionOverride,
        }))}
        notice={notice}
      />
      <h2 className="text-lg">Settings</h2>
      <ServerForm
        initial={{
          id: server.id,
          name: server.name,
          slug: server.slug,
          url: server.url,
          description: server.description,
          authType: server.authType as AuthType,
          authHeaderName: server.authHeaderName ?? "Authorization",
          authValueTemplate: server.authValueTemplate ?? "Bearer {{secret}}",
          authSecretId: server.authSecretId ?? "",
          oauthClientId: server.oauthClientId ?? "",
          oauthClientSecretId: server.oauthClientSecretId ?? "",
          oauthScope: server.oauthScope ?? "",
        }}
        secrets={secrets}
      />
    </>
  )
}
