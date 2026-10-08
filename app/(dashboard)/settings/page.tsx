import { Link2 } from "lucide-react"
import type { Metadata } from "next"

import { ExportCard, RestoreCard } from "@/components/backup-cards"
import { CleanupCard } from "@/components/cleanup-card"
import { CopyableValue } from "@/components/copyable-value"
import { DeleteVaultCard } from "@/components/delete-vault-card"
import { FormNote } from "@/components/form-status"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { ResourcesCard } from "@/components/resources-card"
import {
  ChangePasswordForm,
  RecoveryKeyCard,
  SessionsCard,
} from "@/components/settings-forms"
import { NetworkSection } from "@/components/settings-network"
import { TouchIdCard } from "@/components/touch-id-card"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { UpdatesCard } from "@/components/updates-card"
import { cleanupOverview } from "@/lib/core/cleanup/runtime"
import { deviceKeyInfo } from "@/lib/core/device-keys"
import { isLocalAddress } from "@/lib/core/local-address"
import { networkNotices, networkOverview } from "@/lib/core/network/runtime"
import { resourcesOverview } from "@/lib/core/resources/state"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { updatesOverview } from "@/lib/core/updates/state"
import { getVault } from "@/lib/core/vault"
import { PCP_VERSION } from "@/lib/core/version"
import { desktopUpdater, isDesktopApp } from "@/lib/server/desktop"
import { autoUpdated, installKind } from "@/lib/server/install-kind"
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
    notices,
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
    networkNotices(),
    updatesOverview(),
    deviceKeyInfo(ctx.vaultId),
    cleanupOverview(),
    resourcesOverview(),
  ])

  return (
    <PageColumn width="narrow">
      <PageHeader title="Settings" />
      {query.restored === "1" ? (
        <FormNote message="Restored from the export. You are signed in with the same password as before." />
      ) : null}

      <ListSection title="General">
        <List>
          <ListRow
            icon={
              <IconTile
                icon={Link2}
                size="sm"
                className="bg-tile-browser text-tile-browser-foreground"
              />
            }
            title="Connection address"
            description="Add this as a remote MCP server in your assistant, with an API token as the bearer token. It offers three tools — search_tools, describe_tool and call_tool — that reach every server you connected."
          >
            <div className="basis-full">
              <CopyableValue value={`${publicUrl}/mcp`} />
            </div>
          </ListRow>
          <UpdatesCard
            overview={updates}
            host={installKind()}
            desktopInstall={isDesktopApp() ? desktopUpdater() : null}
            autoUpdated={autoUpdated()}
          />
        </List>
      </ListSection>

      <ListSection title="Sign-in and security">
        <List>
          <ChangePasswordForm username={vault.name} />
          <RecoveryKeyCard username={vault.name} />
          <TouchIdCard username={vault.name} info={touchId} />
          <SessionsCard />
        </List>
      </ListSection>

      <ListSection title="Backup">
        <List>
          <ExportCard username={vault.name} />
          <RestoreCard username={vault.name} mode="settings" />
        </List>
      </ListSection>

      <NetworkSection
        network={network}
        publicUrl={publicUrl}
        pinned={pinned}
        detected={detected}
        outside={isLocalAddress(publicUrl)}
        desktop={isDesktopApp()}
        notice={notices.length > 0}
      />

      <ListSection title="Upkeep">
        <List>
          <CleanupCard overview={cleanup} />
          <ResourcesCard overview={resources} />
        </List>
      </ListSection>

      <DeleteVaultCard username={vault.name} />

      <p className="text-center text-xs text-muted-foreground">
        PCP v{PCP_VERSION} · Your vault is encrypted with your password. No one
        else holds a key.
      </p>
    </PageColumn>
  )
}
