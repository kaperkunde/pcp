import { FolderGit2, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import {
  ItemSyncForm,
  RemoveRepoButton,
  RepoSettingsForm,
  SyncRepoButton,
} from "@/components/repo-forms"
import { Badge } from "@/components/ui/badge"
import { ButtonLink } from "@/components/ui/button"
import { Disclosure } from "@/components/ui/disclosure"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { isPcpError } from "@/lib/core/errors"
import { repoChangeHref } from "@/lib/core/repos/notices"
import { githubSignInOffered } from "@/lib/core/repos/signin"
import {
  getRepo,
  githubSignInSecret,
  linkedItemNames,
  listRepoItems,
  type RepoItemState,
} from "@/lib/core/repos/store"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Repository" }

export const dynamic = "force-dynamic"

const KIND: Record<string, string> = {
  skill: "Skill",
  wrapper: "Wrapper",
  flow: "Browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
}

const STATE: Record<RepoItemState, string> = {
  ok: "In step",
  review: "A change waits for you",
  conflict: "Conflict",
  local: "Your change is not pushed",
  missing: "Not in the repository",
  error: "Sync failed",
}

/** One linked repository: what waits, its items and how each syncs, its settings. */
export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  let repo: Awaited<ReturnType<typeof getRepo>>

  try {
    repo = await getRepo(ctx, id)
  } catch (error) {
    if (isPcpError(error)) {
      return (
        <PageColumn width="narrow">
          <PageHeader
            back={{ href: "/settings/repositories", label: "Repositories" }}
            title="Repository"
          />
          <p className="text-muted-foreground" role="alert">
            There is no such linked repository.
          </p>
        </PageColumn>
      )
    }

    throw error
  }

  const [items, secrets, signedIn] = await Promise.all([
    listRepoItems(ctx, id),
    listSecrets(ctx),
    githubSignInSecret(ctx),
  ])
  const names = await linkedItemNames(ctx, items)
  const waiting = items.filter((item) => item.data.pending)
  const writable = repo.access === "write"

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/settings/repositories", label: "Repositories" }}
        icon={<IconTile icon={FolderGit2} size="lg" />}
        title={`${repo.owner}/${repo.name}`}
        description={`Branch ${repo.branch} · ${writable ? "Read and write" : "Read-only"} · ${repo.trust === "trusted" ? "Trusted" : "Not trusted"}`}
        action={
          <ButtonLink href={`/settings/repositories/${id}/browse`}>
            Add items from it
          </ButtonLink>
        }
      />

      {waiting.length > 0 ? (
        <ListSection title="Waiting for you">
          <List as="ul">
            {waiting.map((item) => (
              <ListRow
                as="li"
                key={item.id}
                href={repoChangeHref(item.id)}
                title={item.data.path}
                description={
                  item.data.pending!.kind === "conflict"
                    ? "Both changed: keep yours, take theirs, or let an assistant help"
                    : "A change to read and approve"
                }
                trailing={
                  <Badge variant="solid-warning">
                    {item.data.pending!.kind === "conflict"
                      ? "Conflict"
                      : "Review"}
                  </Badge>
                }
              />
            ))}
          </List>
        </ListSection>
      ) : null}

      {!writable ? (
        <p
          className="flex items-start gap-3 rounded-xl bg-warning/10 p-4 text-sm ring-1 ring-warning/30"
          role="note"
        >
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <span>
            This is someone else&apos;s repository. Syncing from it brings in
            what they push: a changed skill can put their instructions in front
            of your assistants (prompt injection).{" "}
            {repo.trust === "trusted"
              ? "You trust it, so a skill's text changes without asking you."
              : "Every change waits for you to read it first."}
          </span>
        </p>
      ) : null}

      <ListSection
        title="Linked items"
        description="Sync compares both sides by hash. When only one side changed, that change wins; when both did, nothing is applied and you choose."
        action={
          writable ? (
            <ButtonLink
              href={`/settings/repositories/${id}/push`}
              variant="secondary"
              size="sm"
            >
              Push your items
            </ButtonLink>
          ) : undefined
        }
      >
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is linked yet. Add items from the repository
            {writable ? ", or push yours to it" : ""}.
          </p>
        ) : (
          <List as="ul">
            {items.map((item) => {
              const name = names.get(item.itemId) ?? item.data.path

              return (
                <ListRow
                  as="li"
                  key={item.id}
                  title={name}
                  description={`${KIND[item.kind] ?? item.kind} · ${item.data.path} · ${STATE[item.state as RepoItemState] ?? item.state}${item.data.note ? ` · ${item.data.note}` : ""}`}
                >
                  <ItemSyncForm
                    itemId={item.id}
                    label={name}
                    frequency={item.frequency}
                    bidirectional={item.bidirectional}
                    writable={writable}
                  />
                </ListRow>
              )
            })}
          </List>
        )}
        <div className="pt-3">
          <SyncRepoButton repoId={id} />
        </div>
      </ListSection>

      <List>
        <Disclosure
          inList
          title="Settings"
          description="Access, trust and how PCP signs in to GitHub"
        >
          <RepoSettingsForm
            repoId={id}
            secrets={secrets
              .filter((secret) => secret.kind === "text")
              .map(({ id: secretId, name }) => ({ id: secretId, name }))}
            githubOffered={githubSignInOffered()}
            signedIn={signedIn !== null}
            initial={{
              access: repo.access,
              trust: repo.trust,
              signIn: repo.signIn,
              secretId: repo.signIn === "token" ? repo.secretId : null,
            }}
          />
        </Disclosure>
      </List>

      <div className="flex flex-col items-center gap-2 text-center">
        <RemoveRepoButton repoId={id} />
        <p className="text-xs text-muted-foreground">
          Unlinks it: the items you added stay in your vault, and nothing in the
          repository changes.
        </p>
      </div>
    </PageColumn>
  )
}
