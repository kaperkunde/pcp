import type { Metadata } from "next"

import { ExportCard, RestoreCard } from "@/components/backup-cards"
import { CleanupCard } from "@/components/cleanup-card"
import { CopyableValue } from "@/components/copyable-value"
import { DeleteVaultCard } from "@/components/delete-vault-card"
import { FormNote } from "@/components/form-status"
import { DdnsCard, HttpsCard, PcpggCard } from "@/components/network-forms"
import { OutsideAccessCard } from "@/components/outside-access-card"
import { PageHeader } from "@/components/page-header"
import { ResourcesCard } from "@/components/resources-card"
import { UpdatesCard } from "@/components/updates-card"
import {
  ChangePasswordForm,
  PublicUrlForm,
  RecoveryKeyCard,
  SessionsCard,
} from "@/components/settings-forms"
import { TouchIdCard } from "@/components/touch-id-card"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cleanupOverview } from "@/lib/core/cleanup/runtime"
import { deviceKeyInfo } from "@/lib/core/device-keys"
import { isLocalAddress } from "@/lib/core/local-address"
import { resourcesOverview } from "@/lib/core/resources/state"
import { networkOverview } from "@/lib/core/network/runtime"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { updatesOverview } from "@/lib/core/updates/state"
import { getVault } from "@/lib/core/vault"
import { desktopUpdater, isDesktopApp } from "@/lib/server/desktop"
import {
  autoUpdated,
  hostUpdater,
  installKind,
} from "@/lib/server/install-kind"
import { publicUrlFor, requestOrigin } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Settings" }

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const query = await searchParams
  const [
    pinned,
    detected,
    publicUrl,
    vault,
    network,
    updates,
    touchId,
    cleanup,
    resources,
  ] = await Promise.all([
    getSetting(ctx, SETTING_PUBLIC_URL),
    requestOrigin(),
    publicUrlFor(ctx),
    getVault(ctx.vaultId),
    networkOverview(),
    updatesOverview(),
    deviceKeyInfo(ctx.vaultId),
    cleanupOverview(),
    resourcesOverview(),
  ])

  return (
    <>
      <PageHeader title="Settings" />
      {query.restored === "1" ? (
        <FormNote message="Restored from the export. You are signed in with the same password as before." />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Gateway endpoint</CardTitle>
          <CardDescription>
            Add this as a remote MCP server in your assistant, with an API token
            as the bearer token. It offers three tools — search_tools,
            describe_tool and call_tool — that reach every server you connected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyableValue value={`${publicUrl}/mcp`} />
        </CardContent>
      </Card>
      <PublicUrlForm
        pinned={pinned ?? ""}
        detected={detected}
        username={vault.name}
      />
      {isLocalAddress(publicUrl) ? (
        <OutsideAccessCard address={publicUrl} desktop={isDesktopApp()} />
      ) : null}
      <PcpggCard
        pcpgg={network.pcpgg}
        ports={network.ports}
        pinnedPublicUrl={pinned}
        username={vault.name}
      />
      <DdnsCard ddns={network.ddns} />
      <HttpsCard
        https={network.https}
        turnedOff={network.httpsTurnedOff}
        ddnsName={network.ddnsName}
        ports={network.ports}
        pinnedPublicUrl={pinned}
        username={vault.name}
        pcpggName={network.pcpgg ? network.pcpgg.name : undefined}
      />
      <UpdatesCard
        overview={updates}
        host={installKind()}
        desktopInstall={isDesktopApp() ? desktopUpdater() : null}
        autoUpdated={autoUpdated()}
        hostUpdater={hostUpdater()}
      />
      <CleanupCard overview={cleanup} />
      <ResourcesCard overview={resources} />
      <ChangePasswordForm username={vault.name} />
      <RecoveryKeyCard username={vault.name} />
      <TouchIdCard username={vault.name} info={touchId} />
      <SessionsCard />
      <ExportCard username={vault.name} />
      <RestoreCard username={vault.name} mode="settings" />
      <DeleteVaultCard username={vault.name} />
    </>
  )
}
