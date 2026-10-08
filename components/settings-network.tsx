import { Globe } from "lucide-react"

import { DdnsCard, HttpsCard, PcpggCard } from "@/components/network-forms"
import { OutsideAccessCard } from "@/components/outside-access-card"
import { PublicUrlForm } from "@/components/settings-forms"
import { Disclosure } from "@/components/ui/disclosure"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListSection } from "@/components/ui/list"
import type { NetworkOverview } from "@/lib/core/network/runtime"

/** How PCP is reached, in a few words, for the grey line under the row. */
function howReached(network: NetworkOverview, outside: boolean): string {
  if (network.pcpgg) return "Through pcp.gg"
  if (network.https) return "Over HTTPS, with a certificate from Let's Encrypt"
  if (network.ddns) return "Through dynamic DNS"
  if (outside) return "Only this computer or your own network can reach it"
  return "At the address you set"
}

/**
 * Settings → Network: one row, "Reachable at <host>", folded unless PCP has
 * something to say about the network (a notice in the bell) or is at an
 * address only the owner's own network reaches. Inside: how to reach PCP
 * from outside, and the rows that set it up: public address, pcp.gg,
 * dynamic DNS, HTTPS. Each row opens in place.
 */
export function NetworkSection({
  network,
  publicUrl,
  pinned,
  detected,
  outside,
  desktop,
  notice,
  username,
}: {
  network: NetworkOverview
  /** The address assistants are told, from the public address or the request. */
  publicUrl: string
  /** The public address the owner set, if any. */
  pinned: string | null
  /** The address this request came in on. */
  detected: string
  /** PCP's address is one only the owner's own network reaches. */
  outside: boolean
  desktop: boolean
  /** The bell has something about the network. */
  notice: boolean
  /** The vault's name, for confirming a change of the public address. */
  username: string
}) {
  return (
    <ListSection title="Network">
      <List>
        <Disclosure
          inList
          title={`Reachable at ${new URL(publicUrl).host}`}
          description={`${howReached(network, outside)}. Open to change how PCP is reached.`}
          icon={
            <IconTile
              icon={Globe}
              size="sm"
              className="bg-tile-browser text-tile-browser-foreground"
            />
          }
          defaultOpen={notice || outside}
        >
          {outside ? (
            <OutsideAccessCard address={publicUrl} desktop={desktop} />
          ) : null}
          <List className="border border-separator bg-transparent">
            <PublicUrlForm
              pinned={pinned ?? ""}
              detected={detected}
              username={username}
            />
            <PcpggCard
              variant="row"
              pcpgg={network.pcpgg}
              ports={network.ports}
              pinnedPublicUrl={pinned}
              username={username}
            />
            <DdnsCard variant="row" ddns={network.ddns} />
            <HttpsCard
              variant="row"
              https={network.https}
              turnedOff={network.httpsTurnedOff}
              ddnsName={network.ddnsName}
              ports={network.ports}
              pinnedPublicUrl={pinned}
              username={username}
              pcpggName={network.pcpgg ? network.pcpgg.name : undefined}
            />
          </List>
        </Disclosure>
      </List>
    </ListSection>
  )
}
