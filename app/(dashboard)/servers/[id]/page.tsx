import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { BrowserDescribeForm } from "@/components/browser-describe-form"
import { CalendarAccountForm } from "@/components/calendar-account-form"
import { EndpointForm } from "@/components/endpoint-form"
import { MailAccountForm } from "@/components/mail-account-form"
import { PageColumn } from "@kaperkunde/ui/page"
import { ServerDetail } from "@/components/server-detail"
import { ServerForm } from "@/components/server-form"
import { ServerPacingForm } from "@/components/server-pacing-form"
import { ExitsCard } from "@/components/exits-card"
import { ServiceCard } from "@/components/service-card"
import { ServiceSettingsForm } from "@/components/service-form"
import { SshAccessCard } from "@/components/ssh-access-card"
import { SshServerForm } from "@/components/ssh-server-form"
import { StorageCard } from "@/components/storage-card"
import { StorageFolderForm } from "@/components/storage-folder-form"
import { StorageFoldersCard } from "@/components/storage-folders-card"
import { WrapperForm } from "@/components/wrapper-form"
import { db } from "@/lib/core/db"
import { isPcpError } from "@/lib/core/errors"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { storedSpec } from "@/lib/core/endpoints"
import { readCallPlan } from "@/lib/core/openapi/plan"
import { pacingOverview, serverPacing } from "@/lib/core/pacing/config"
import { listSecrets } from "@/lib/core/secrets"
import {
  asServerKind,
  extraAuthHeaders,
  getServer,
  isMailKind,
  type AuthType,
  type ServerStatus,
} from "@/lib/core/servers"
import { listExits } from "@/lib/core/exits/exits"
import { serviceView } from "@/lib/core/services/services"
import { sshServerView } from "@/lib/core/ssh/hosts"
import {
  listStorageRoots,
  loadStorageRoot,
  storageRootView,
} from "@/lib/core/storage/roots"
import { describeOAuthConnection } from "@/lib/core/upstream"
import { getWrapper, replacedTools } from "@/lib/core/wrappers/admin"
import { itemAbout } from "@/lib/core/item-about"
import {
  loadToolTiers,
  tierBelowCalls,
  type TierInfo,
} from "@/lib/core/tool-tiers"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Server" }

/** A tool's tier as the page shows it. */
function shownTier(info: TierInfo) {
  return {
    tier: info.tier,
    derived: info.derived,
    override: info.override,
    below: tierBelowCalls(info),
  }
}

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
  const ssh = kind === "ssh" ? sshServerView(server) : null
  const exits = ssh ? await listExits(ctx, { serverId: server.id }) : []
  const folders = ssh ? await listStorageRoots(ctx, server.id) : []
  const storage =
    kind === "storage"
      ? storageRootView(await loadStorageRoot(ctx, server.id))
      : null
  const wrapper = kind === "wrapper" ? await getWrapper(ctx, { id }) : null
  const service = kind === "service" ? await serviceView(ctx, id) : null
  const replaced = await replacedTools(ctx, server.id)
  // Each tool's tier, and whether the owner chose it (tool-tiers.ts).
  const tiers = await loadToolTiers(ctx, [server])
  const about = await itemAbout(ctx, "server", server.id)
  const spec = endpoint
    ? await db().openApiSpec.findUnique({
        where: { serverId: server.id },
        select: { fetchedAt: true },
      })
    : null
  const patches = endpoint
    ? ((await storedSpec(ctx, server.id))?.patches ?? [])
    : []

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

  // PCP's own store has no folder to choose: nothing to set but its
  // tools' levels.
  const settings =
    storage?.backend === "local" ? null : storage ? (
      <StorageFolderForm
        initial={{
          id: server.id,
          name: server.name,
          slug: server.slug,
          description: server.description,
          path: storage.path,
          writeAs: storage.writeAs,
          umask: storage.umask,
          readOnly: storage.readOnly,
        }}
        login={storage.host?.login ?? ""}
      />
    ) : service ? (
      <ServiceSettingsForm
        initial={{
          id: server.id,
          name: server.name,
          slug: server.slug,
          description: server.description,
          env: Object.fromEntries(
            service.env
              .filter((entry) => entry.secretId)
              .map((entry) => [entry.name, entry.secretId!]),
          ),
          values: Object.fromEntries(
            service.env
              .filter((entry) => entry.value !== null)
              .map((entry) => [entry.name, entry.value!]),
          ),
        }}
        variables={service.definition.env.map((entry) => ({
          name: entry.name,
          required: entry.required,
          description: entry.description,
          plain: entry.plain,
          value: entry.value ?? null,
        }))}
        secrets={secrets}
      />
    ) : wrapper ? (
      <WrapperForm
        initial={{
          id: wrapper.id,
          name: wrapper.name,
          slug: wrapper.slug,
          description: wrapper.description,
          callLevels: wrapper.callLevels,
          definition: JSON.stringify(
            { tools: wrapper.tools, secrets: wrapper.secrets },
            null,
            2,
          ),
        }}
        secretNames={secrets.map((secret) => secret.name)}
      />
    ) : browser ? (
      <BrowserDescribeForm
        name={server.name}
        description={server.description}
      />
    ) : ssh ? (
      <SshServerForm
        initial={{
          id: server.id,
          name: server.name,
          slug: server.slug,
          description: server.description,
          host: ssh.host,
          port: String(ssh.port),
          username: ssh.username,
        }}
      />
    ) : kind === "caldav" ? (
      <CalendarAccountForm
        initial={{
          id: server.id,
          name: server.name,
          slug: server.slug,
          description: server.description,
          url: server.url,
          readOnly: server.readOnly,
          authType:
            server.authType === "header" || server.authType === "oauth"
              ? server.authType
              : "basic",
          authUsername: server.authUsername ?? "",
          authSecretId: server.authSecretId ?? "",
          oauthClientId: server.oauthClientId ?? "",
          oauthClientSecretId: server.oauthClientSecretId ?? "",
          oauthScope: server.oauthScope ?? "",
          oauthAuthorizeParams: server.oauthAuthorizeParams ?? "",
        }}
        secrets={secrets}
        redirectUrl={redirectUrl}
      />
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
          mailSaveSent:
            server.mailSaveSent === "always" || server.mailSaveSent === "never"
              ? server.mailSaveSent
              : "auto",
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
          publicOnly: server.publicOnly,
        }}
        secrets={secrets}
        redirectUrl={redirectUrl}
      />
    )

  // A wrapper's tool is paced by the calls its program makes.
  const pace = await serverPacing(ctx, server.id)
  const pacing =
    kind === "wrapper" ? null : (
      <ServerPacingForm
        key={JSON.stringify(pace)}
        serverId={server.id}
        pace={pace}
        browser={browser}
        defaults={await pacingDefaults(ctx, browser)}
      />
    )

  return (
    <PageColumn width="narrow">
      <ServerDetail
        server={{
          id: server.id,
          kind,
          name: server.name,
          slug: server.slug,
          description: server.description,
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
          flow: wrapper?.flow ?? false,
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
            tier: shownTier(
              tiers.get(`${server.id}/${tool.name}`) ?? {
                tier: "destructive",
                derived: "destructive",
                override: null,
                seen: null,
              },
            ),
          }
        })}
        notice={notice}
        redirectUrl={redirectUrl}
        settings={settings}
        pacing={pacing}
        about={about}
      >
        {ssh ? <SshAccessCard serverId={server.id} view={ssh} /> : null}
        {storage ? <StorageCard view={storage} /> : null}
        {ssh ? (
          <StorageFoldersCard serverId={server.id} folders={folders} />
        ) : null}
        {ssh ? <ExitsCard serverId={server.id} exits={exits} /> : null}
        {service ? <ServiceCard view={service} /> : null}
      </ServerDetail>
    </PageColumn>
  )
}

/** What a server follows without a pace of its own, by kind of call. */
async function pacingDefaults(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  browser: boolean,
) {
  const { classes } = await pacingOverview(ctx)

  return browser
    ? [{ label: "per site,", pace: classes.browser_act.pace }]
    : [
        {
          label: "calls that change things:",
          pace: classes.server_change.pace,
        },
        { label: "calls that only read:", pace: classes.server_read.pace },
      ]
}
