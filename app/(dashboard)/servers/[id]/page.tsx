import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EndpointForm } from "@/components/endpoint-form"
import { MailAccountForm } from "@/components/mail-account-form"
import { PageHeader } from "@/components/page-header"
import { ServerDetail } from "@/components/server-detail"
import { ServerForm } from "@/components/server-form"
import { WrapperForm } from "@/components/wrapper-form"
import { db } from "@/lib/core/db"
import { isPcpError } from "@/lib/core/errors"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { readStoredPatches } from "@/lib/core/openapi/patch"
import { readCallPlan } from "@/lib/core/openapi/plan"
import { listSecrets } from "@/lib/core/secrets"
import {
  asServerKind,
  extraAuthHeaders,
  getServer,
  isMailKind,
  type AuthType,
  type ServerStatus,
} from "@/lib/core/servers"
import { describeOAuthConnection } from "@/lib/core/upstream"
import { getWrapper, replacedTools } from "@/lib/core/wrappers/admin"
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

  const kind = asServerKind(server.kind)
  const endpoint = kind === "openapi"
  const mail = isMailKind(kind)
  const browser = kind === "browser"
  const wrapper = kind === "wrapper" ? await getWrapper(ctx, { id }) : null
  const replaced = await replacedTools(ctx, server.id)
  const spec = endpoint
    ? await db().openApiSpec.findUnique({
        where: { serverId: server.id },
        select: { fetchedAt: true, patches: true },
      })
    : null
  const patches = readStoredPatches(spec?.patches)

  const authExtraHeaders = await extraAuthHeaders(server.id)

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
            message: `Connected to ${server.name}. Tell the assistant that asked that it is connected, and it carries on.`,
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
          kind,
          name: server.name,
          slug: server.slug,
          url: server.url,
          smtpUrl: server.smtpUrl,
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
            replacedBy: replaced.get(tool.name) ?? [],
          }
        })}
        notice={notice}
        redirectUrl={redirectUrl}
      />
      <h2 className="text-lg">Settings</h2>
      {wrapper ? (
        <WrapperForm
          initial={{
            id: wrapper.id,
            name: wrapper.name,
            slug: wrapper.slug,
            description: wrapper.description,
            definition: JSON.stringify(
              { tools: wrapper.tools, secrets: wrapper.secrets },
              null,
              2,
            ),
          }}
          secretNames={secrets.map((secret) => secret.name)}
        />
      ) : browser ? (
        <p className="text-muted-foreground">
          The browser&apos;s name, its tabs and the sign-ins it keeps are on the{" "}
          <Link href="/browser" className="underline">
            Browser
          </Link>{" "}
          page. Which sites each token may open is on the token&apos;s page,
          with web fetch.
        </p>
      ) : mail ? (
        <MailAccountForm
          initial={{
            id: server.id,
            protocol: kind === "imap" ? "imap" : "jmap",
            name: server.name,
            slug: server.slug,
            description: server.description,
            url: server.url,
            smtpUrl: server.smtpUrl ?? "",
            readOnly: server.readOnly,
            authType:
              server.authType === "header" || server.authType === "oauth"
                ? server.authType
                : "basic",
            authUsername: server.authUsername ?? "",
            authSecretId: server.authSecretId ?? "",
            mailFrom: server.mailFrom ?? "",
            oauthClientId: server.oauthClientId ?? "",
            oauthClientSecretId: server.oauthClientSecretId ?? "",
            oauthScope: server.oauthScope ?? "",
            oauthAuthorizeParams: server.oauthAuthorizeParams ?? "",
          }}
          secrets={secrets}
          redirectUrl={redirectUrl}
        />
      ) : endpoint ? (
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
              server.authType === "header" ||
              server.authType === "basic" ||
              server.authType === "oauth"
                ? server.authType
                : "none",
            authUsername: server.authUsername ?? "",
            authHeaderName: server.authHeaderName ?? "Authorization",
            authValueTemplate: server.authValueTemplate ?? "Bearer {{secret}}",
            authSecretId: server.authSecretId ?? "",
            authExtraHeaders,
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
            authExtraHeaders,
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
