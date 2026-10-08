import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { DdnsCard, HttpsCard, PcpggCard } from "@/components/network-forms"
import { UpdateCheckCard } from "@/components/updates-card"
import { ButtonLink } from "@/components/ui/button"
import { networkOverview } from "@/lib/core/network/runtime"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { getUpdateConfig } from "@/lib/core/updates/state"
import { getVault } from "@/lib/core/vault"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Reach PCP from anywhere" }
export const dynamic = "force-dynamic"

/**
 * The optional step after setup: pcp.gg, or dynamic DNS and HTTPS, for an
 * owner running PCP at home. The same forms are rows under Settings › Network.
 */
export default async function SetupNetworkPage() {
  const ctx = await requireContext()
  const [network, pinned, updates, vault] = await Promise.all([
    networkOverview(),
    getSetting(ctx, SETTING_PUBLIC_URL),
    getUpdateConfig(),
    getVault(ctx.vaultId),
  ])

  return (
    <AuthShell
      title="Reach PCP from anywhere (optional)"
      intro={
        <p>
          If PCP runs at home and assistants should reach it from outside,
          connect it to pcp.gg, or let PCP keep a name pointed at your
          connection and serve itself over HTTPS. Skip this if PCP is only for
          this network, or if you put your own proxy in front of it. You can
          change it later under Settings.
        </p>
      }
    >
      <ButtonLink href="/home" variant="outline" size="lg">
        Skip for now — open PCP
      </ButtonLink>
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
      <UpdateCheckCard check={updates.check} />
      <ButtonLink href="/home" size="lg">
        Done — open PCP
      </ButtonLink>
    </AuthShell>
  )
}
