import { FolderGit2 } from "lucide-react"
import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { AddCommonRepoButton, AddRepoDialog } from "@/components/repo-forms"
import { Badge } from "@/components/ui/badge"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { isCommonRepository } from "@/lib/core/repos/common"
import { githubSignInOffered } from "@/lib/core/repos/signin"
import {
  githubSignInSecret,
  listRepoItems,
  listRepos,
} from "@/lib/core/repos/store"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Repositories" }

export const dynamic = "force-dynamic"

/**
 * Settings → Repositories: the GitHub repositories the owner shares items
 * through (lib/core/repos/), one row each, and Add a repository.
 */
export default async function RepositoriesPage() {
  const ctx = await requireContext()
  const [repos, items, secrets, signedIn] = await Promise.all([
    listRepos(ctx),
    listRepoItems(ctx),
    listSecrets(ctx),
    githubSignInSecret(ctx),
  ])

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Repositories"
        description="Share skills, wrappers, browser flows, API endpoints, MCP servers and services with other people through GitHub, as plain files. Not a backup: nothing secret goes there."
        action={
          <AddRepoDialog
            secrets={secrets
              .filter((secret) => secret.kind === "text")
              .map(({ id, name }) => ({ id, name }))}
            githubOffered={githubSignInOffered()}
            signedIn={signedIn !== null}
          />
        }
      />

      {repos.some(isCommonRepository) ? null : (
        <ListSection
          title="PCP's common items"
          description="Ready-made definitions kept by pcp.gg in a public repository, kaperkunde/pcp-gg-common: services to run on your own SSH server, to start. It is added read-only and not trusted: you read every item before adding it, what you add stays as you read it, and a change there waits for you as an update. It never holds a secret."
        >
          <div className="flex justify-start">
            <AddCommonRepoButton />
          </div>
        </ListSection>
      )}

      <ListSection
        title="Linked repositories"
        description="Each item you add from one, or push to one, syncs as you choose on the repository's page. Sync runs while you or an assistant use PCP, never on its own."
      >
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No repository is linked yet.
          </p>
        ) : (
          <List as="ul">
            {repos.map((repo) => {
              const linked = items.filter((item) => item.repoId === repo.id)
              const waiting = linked.filter((item) => item.data.pending).length

              return (
                <ListRow
                  as="li"
                  key={repo.id}
                  href={`/settings/repositories/${repo.id}`}
                  icon={<IconTile icon={FolderGit2} size="sm" />}
                  title={`${repo.owner}/${repo.name}`}
                  description={`${repo.branch} · ${repo.access === "write" ? "Read and write" : "Read-only"} · ${repo.trust === "trusted" ? "Trusted" : "Not trusted"} · ${linked.length} item${linked.length === 1 ? "" : "s"}`}
                  trailing={
                    waiting > 0 ? (
                      <Badge variant="warning">{waiting} waiting</Badge>
                    ) : null
                  }
                />
              )
            })}
          </List>
        )}
      </ListSection>
    </PageColumn>
  )
}
