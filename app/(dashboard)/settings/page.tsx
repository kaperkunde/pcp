import type { Metadata } from "next"

import { CopyableValue } from "@/components/copyable-value"
import { DdnsCard, HttpsCard } from "@/components/network-forms"
import { OutsideAccessCard } from "@/components/outside-access-card"
import { PageHeader } from "@/components/page-header"
import {
  ChangePasswordForm,
  PublicUrlForm,
  RecoveryKeyCard,
  SessionsCard,
} from "@/components/settings-forms"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { isLocalAddress } from "@/lib/core/local-address"
import { networkOverview } from "@/lib/core/network/runtime"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { getVault } from "@/lib/core/vault"
import { isDesktopApp } from "@/lib/server/desktop"
import { publicUrlFor, requestOrigin } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Settings" }

export default async function SettingsPage() {
  const ctx = await requireContext()
  const [pinned, detected, publicUrl, vault, network] = await Promise.all([
    getSetting(ctx, SETTING_PUBLIC_URL),
    requestOrigin(),
    publicUrlFor(ctx),
    getVault(ctx.vaultId),
    networkOverview(),
  ])

  return (
    <>
      <PageHeader title="Settings" />
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
      <SessionsCard />
    </>
  )
}
