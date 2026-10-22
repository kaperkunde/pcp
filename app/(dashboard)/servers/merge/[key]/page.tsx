import type { Metadata } from "next"

import { MergeReview } from "@/components/merge-review"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { Card } from "@/components/ui/card"
import { db } from "@/lib/core/db"
import { identicalDefinitions } from "@/lib/core/definitions"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Merge endpoints" }

/**
 * API endpoints with the same schema, edits and tool descriptions, offered
 * to become servers of one definition: which one is kept, what the others
 * take from it, and nothing until the owner says so.
 */
export default async function MergePage({
  params,
}: {
  params: Promise<{ key: string }>
}) {
  const ctx = await requireContext()
  const { key } = await params
  const group = await identicalDefinitions(ctx, key)

  if (!group) {
    return (
      <PageColumn width="narrow">
        <PageHeader
          back={{ href: "/servers", label: "Servers" }}
          title="Merge endpoints"
        />
        <Card className="p-5 text-sm text-muted-foreground">
          These endpoints no longer have the same schema, or they were merged or
          kept apart already. Nothing to do here.
        </Card>
      </PageColumn>
    )
  }

  // Where each definition reads its schema from, as its first server has it.
  const sources = await db().mcpServer.findMany({
    where: {
      id: {
        in: group.definitions.map((definition) => definition.instances[0]!.id),
      },
    },
    select: { definitionId: true, specSource: true, specUrl: true },
  })
  const schemaOf = new Map(
    sources.map((row) => [
      row.definitionId,
      row.specSource === "url" && row.specUrl ? row.specUrl : null,
    ]),
  )

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        title="Merge into one definition?"
        description="These API endpoints have the same schema, edits and tool descriptions. Merged, they are servers of one definition: a change to its description, schema, edits or tool descriptions reaches all of them. Each keeps its own name, address, secret, levels and note."
      />
      <MergeReview
        groupKey={group.key}
        definitions={group.definitions.map((definition) => ({
          id: definition.id,
          slug: definition.slug,
          name: definition.name,
          description: definition.description,
          schemaUrl: schemaOf.get(definition.id) ?? null,
          instances: definition.instances.map((instance) => ({
            id: instance.id,
            slug: instance.slug,
            url: instance.url,
          })),
        }))}
      />
    </PageColumn>
  )
}
