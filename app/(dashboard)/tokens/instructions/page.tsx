import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { InstructionsUpdate } from "@/components/token-instructions"
import { Card, CardDescription, CardTitle } from "@/components/ui/card"
import { outdatedInstructions } from "@/lib/core/instructions"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Suggested instructions" }

/**
 * Where the bell's notice leads once PCP's suggested instructions change:
 * every assistant whose instructions follow an older suggestion, each with
 * its text, PCP's, and the two merged, to keep, take or save.
 */
export default async function InstructionsUpdatesPage() {
  const ctx = await requireContext()
  const updates = await outdatedInstructions(ctx)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/tokens", label: "Assistants" }}
        title="Suggested instructions"
        description="PCP's suggested instructions for assistants changed since these copied them. For each, keep yours as they are, take PCP's new ones, or save the two merged."
      />

      {updates.length === 0 ? (
        <Card>
          <CardTitle>Nothing to look at</CardTitle>
          <CardDescription>
            Every assistant follows PCP&apos;s latest suggestion, or
            instructions of your own you chose to keep.
          </CardDescription>
        </Card>
      ) : (
        updates.map((update) => (
          <InstructionsUpdate
            key={update.tokenId}
            tokenId={update.tokenId}
            tokenName={update.tokenName}
            mine={update.mine}
            theirs={update.theirs}
            merged={update.merge.text}
            conflicts={update.merge.conflicts}
          />
        ))
      )}
    </PageColumn>
  )
}
