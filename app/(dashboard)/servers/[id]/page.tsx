import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { EndpointForm } from "@/components/endpoint-form"
import { PageHeader } from "@/components/page-header"
import { ServerDetail } from "@/components/server-detail"
import { ServerForm } from "@/components/server-form"
import { db } from "@/lib/core/db"
import { isPcpError } from "@/lib/core/errors"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { readStoredPatches } from "@/lib/core/openapi/patch"
import { readCallPlan } from "@/lib/core/openapi/plan"
import { listSecrets } from "@/lib/core/secrets"
import { getServer, type AuthType, type ServerStatus } from "@/lib/core/servers"
import { describeOAuthConnection } from "@/lib/core/upstream"
import { publicUrlFor } from "@/lib/server/public-url"
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

  const endpoint = server.kind === "openapi"
  const spec = endpoint
    ? await db().openApiSpec.findUnique({
        where: { serverId: server.id },
        select: { fetchedAt: true, patches: true },
      })
    : null
  const patches = readStoredPatches(spec?.patches)

  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  const redirectUrl = oauthRedirectUrl(await publicUrlFor(ctx))

  const oauthConnection = await describeOAuthConnection(ctx, server).catch(
    () => null,
  )

  const notice =
    typeof query.error === "string" && query.error
      ? { kind: "error" as const, message: query.error }
      : query.connected
        ? {
            kind: "ok" as const,
            message: `Connected to ${server.name}. An assistant waiting for this carries on by itself; one that stopped waiting needs telling.`,
          }
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
          kind: endpoint ? "openapi" : "mcp",
          name: server.name,
          slug: server.slug,
          url: server.url,
          enabled: server.enabled,
          readOnly: server.readOnly,
          publicOnly: server.publicOnly,
          specSource:
            server.specSource === "url" || server.specSource === "upload"
              ? server.specSource
              : null,
          specUrl: server.specUrl,
          authType: server.authType as AuthType,
          status: server.status as ServerStatus,
          statusMessage: server.statusMessage,
          connected:
            server.authType !== "oauth" || server.oauthConnectedAt !== null,
          lastSyncedAt: server.lastSyncedAt,
          oauthConnection,
          oauthAuthorizeParams: server.oauthAuthorizeParams ?? "",
        }}
        tools={server.tools.map((tool) => {
          const plan = readCallPlan(tool.operation)

          return {
            name: tool.name,
            title: tool.title,
            description: tool.description,
            descriptionOverride: tool.descriptionOverride,
            operation: plan ? { method: plan.method, path: plan.path } : null,
          }
        })}
        notice={notice}
        redirectUrl={redirectUrl}
      />
      <h2 className="text-lg">Settings</h2>
      {endpoint ? (
        <EndpointForm
          initial={{
            id: server.id,
            name: server.name,
            slug: server.slug,
            description: server.description,
            specSource: server.specSource === "upload" ? "upload" : "url",
            specUrl: server.specUrl ?? "",
            specReadAt: spec?.fetchedAt ?? null,
            specUrlFromAssistant: server.specUrlFromAssistant,
            patches: patches.length > 0 ? JSON.stringify(patches, null, 2) : "",
            // Not prefilled: a value in the field is something the owner
            // typed, which is what lets them confirm where a secret goes.
            baseUrl: "",
            currentBaseUrl: server.url,
            readOnly: server.readOnly,
            publicOnly: server.publicOnly,
            authType:
              server.authType === "header" || server.authType === "oauth"
                ? server.authType
                : "none",
            authHeaderName: server.authHeaderName ?? "Authorization",
            authValueTemplate: server.authValueTemplate ?? "Bearer {{secret}}",
            authSecretId: server.authSecretId ?? "",
            oauthClientId: server.oauthClientId ?? "",
            oauthClientSecretId: server.oauthClientSecretId ?? "",
            oauthScope: server.oauthScope ?? "",
            oauthAuthorizeParams: server.oauthAuthorizeParams ?? "",
          }}
          secrets={secrets}
          redirectUrl={redirectUrl}
        />
      ) : (
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
            oauthAuthorizeParams: server.oauthAuthorizeParams ?? "",
          }}
          secrets={secrets}
          redirectUrl={redirectUrl}
        />
      )}
    </>
  )
}
