import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { DdnsCard, HttpsCard } from "@/components/network-forms"
import { ButtonLink } from "@/components/ui/button"
import { networkOverview } from "@/lib/core/network/runtime"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Reach PCP from anywhere" }
export const dynamic = "force-dynamic"

/**
 * The optional step after setup: dynamic DNS and HTTPS for an owner
 * running PCP at home. The same cards are under Settings.
 */
export default async function SetupNetworkPage() {
  const ctx = await requireContext()
  const [network, pinned] = await Promise.all([
    networkOverview(),
    getSetting(ctx, SETTING_PUBLIC_URL),
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
        ddnsName={network.ddnsName}
        ports={network.ports}
        pinnedPublicUrl={pinned}
      />
      <ButtonLink href="/servers" size="lg">
        Done — open PCP
      </ButtonLink>
    </AuthShell>
  )
}
