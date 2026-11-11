import type { Metadata } from "next"

import { OwnToolTiers } from "@/components/own-tool-tiers"
import { PageColumn } from "@kaperkunde/ui/page"
import { PageHeader } from "@kaperkunde/ui/page"
import { listOwnToolTiers } from "@/lib/core/own-tool-tiers"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "PCP's own tools" }

export const dynamic = "force-dynamic"

/**
 * Settings → PCP's own tools: each tool PCP offers at /mcp with its tier,
 * which the owner can set (lib/core/own-tool-tiers.ts). The tier is what
 * PCP tells assistants' apps the tool can do; some apps ask before every
 * Destructive call however you answered them before.
 */
export default async function OwnToolsPage() {
  const ctx = await requireContext()
  const tools = await listOwnToolTiers(ctx)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="PCP's own tools"
        description="What PCP tells assistants' apps each of its own tools can do: Read, Write or Destructive. Some apps ask you before every Destructive call, even one you always allow; a lower tier here stops that, but only what it does decides, so keep it honest. Default is PCP's own."
      />
      <OwnToolTiers tools={tools} />
    </PageColumn>
  )
}
