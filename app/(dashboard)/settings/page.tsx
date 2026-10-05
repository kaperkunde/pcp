import type { Metadata } from "next"

import { ExportCard, RestoreCard } from "@/components/backup-cards"
import { CopyableValue } from "@/components/copyable-value"
import { FormNote } from "@/components/form-status"
import { DdnsCard, HttpsCard } from "@/components/network-forms"
import { OutsideAccessCard } from "@/components/outside-access-card"
import { PageHeader } from "@/components/page-header"
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
import { deviceKeyInfo } from "@/lib/core/device-keys"
import { isLocalAddress } from "@/lib/core/local-address"
import { networkOverview } from "@/lib/core/network/runtime"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { getVault } from "@/lib/core/vault"
import { isDesktopApp } from "@/lib/server/desktop"
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
  const [pinned, detected, publicUrl, vault, network, touchId] =
    await Promise.all([
      getSetting(ctx, SETTING_PUBLIC_URL),
      requestOrigin(),
      publicUrlFor(ctx),
      getVault(ctx.vaultId),
      networkOverview(),
      deviceKeyInfo(ctx.vaultId),
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
      <PublicUrlForm pinned={pinned ?? ""} detected={detected} />
      {isLocalAddress(publicUrl) ? (
        <OutsideAccessCard address={publicUrl} desktop={isDesktopApp()} />
      ) : null}
      <DdnsCard ddns={network.ddns} />
      <HttpsCard
        https={network.https}
        ddnsName={network.ddnsName}
        ports={network.ports}
        pinnedPublicUrl={pinned}
      />
      <ChangePasswordForm username={vault.name} />
      <RecoveryKeyCard username={vault.name} />
      <TouchIdCard username={vault.name} info={touchId} />
      <SessionsCard />
      <ExportCard username={vault.name} />
      <RestoreCard username={vault.name} mode="settings" />
    </>
  )
}
