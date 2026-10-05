import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { DdnsCard, HttpsCard } from "@/components/network-forms"
import { UpdateCheckCard } from "@/components/updates-card"
import { ButtonLink } from "@/components/ui/button"
import { networkOverview } from "@/lib/core/network/runtime"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { getUpdateConfig } from "@/lib/core/updates/state"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Reach PCP from anywhere" }
export const dynamic = "force-dynamic"

/**
 * The optional step after setup: dynamic DNS and HTTPS for an owner
 * running PCP at home. The same cards are under Settings.
 */
export default async function SetupNetworkPage() {
  const ctx = await requireContext()
  const [network, pinned, updates] = await Promise.all([
    networkOverview(),
    getSetting(ctx, SETTING_PUBLIC_URL),
    getUpdateConfig(),
  ])

  return (
    <AuthShell
      title="Reach PCP from anywhere (optional)"
      intro={
        <p>
          If PCP runs at home and assistants should reach it from outside, PCP
          can keep a name pointed at your connection and serve itself over
          HTTPS. Skip this if PCP is only for this network, or if you put your
          own proxy in front of it. You can change it later under Settings.
        </p>
      }
    >
      <ButtonLink href="/servers" variant="outline" size="lg">
        Skip for now — open PCP
      </ButtonLink>
      <DdnsCard ddns={network.ddns} />
      <HttpsCard
        https={network.https}
        turnedOff={network.httpsTurnedOff}
        ddnsName={network.ddnsName}
        ports={network.ports}
        pinnedPublicUrl={pinned}
      />
      <UpdateCheckCard check={updates.check} />
      <ButtonLink href="/servers" size="lg">
        Done — open PCP
      </ButtonLink>
    </AuthShell>
  )
}
