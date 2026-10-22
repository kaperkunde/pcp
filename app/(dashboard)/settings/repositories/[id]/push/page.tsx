import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { PushChooser } from "@/components/repo-forms"
import { itemRoot } from "@/lib/core/repos/layout"
import { localItems } from "@/lib/core/repos/local"
import { getRepo, listRepoItems } from "@/lib/core/repos/store"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Push to a repository" }

export const dynamic = "force-dynamic"

const KIND: Record<string, string> = {
  skill: "Skill",
  wrapper: "Wrapper",
  flow: "Browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
}

/**
 * The owner's shareable items, to push some or all to a read-write
 * repository: one commit each, as PCP writes them (names of secrets, never
 * a value).
 */
export default async function PushPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const repo = await getRepo(ctx, id)
  const skipped: Array<{ id: string; name: string; message: string }> = []
  const [items, linked] = await Promise.all([
    localItems(ctx, skipped),
    listRepoItems(ctx),
  ])

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: `/settings/repositories/${id}`, label: "Repository" }}
        title={`Push to ${repo.owner}/${repo.name}`}
        description="Skills, wrappers, browser flows, API endpoints and MCP servers, as files anyone with the repository reads. Secrets go by name only: their values, OAuth tokens and your other accounts never leave PCP."
      />
      {repo.access !== "write" ? (
        <p className="text-muted-foreground" role="alert">
          This repository is read-only here: change its access to push to it.
        </p>
      ) : (
        <PushChooser
          repoId={id}
          items={items.map((item) => {
            const link = linked.find((entry) => entry.itemId === item.id)
            const ref = { kind: item.document.kind, name: item.document.name }

            return {
              kind: item.document.kind,
              id: item.id,
              label: `${KIND[item.document.kind]} ${item.document.name}`,
              note: link
                ? link.repoId === id
                  ? `Linked here at ${link.data.path}`
                  : "Linked to another repository"
                : `Goes to ${itemRoot(ref)}`,
            }
          })}
        />
      )}
      {skipped.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Left out:{" "}
          {skipped
            .map((entry) => `${entry.name} (${entry.message})`)
            .join("; ")}
        </p>
      ) : null}
    </PageColumn>
  )
}
