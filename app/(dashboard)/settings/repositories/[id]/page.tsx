import { FolderGit2, Globe, Lock, TriangleAlert } from "lucide-react"
import Link from "next/link"
import type { Metadata } from "next"

import { RelativeDate } from "@/components/local-date"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import {
  ExcludeButton,
  ItemSyncForm,
  RemoveRepoButton,
  RepoSettingsForm,
  SyncRepoButton,
} from "@/components/repo-forms"
import { Badge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
import { Disclosure } from "@/components/ui/disclosure"
import { IconTile } from "@/components/ui/icon-tile"
import { Checkbox } from "@/components/ui/input"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { isPcpError } from "@/lib/core/errors"
import { repoChangeHref } from "@/lib/core/repos/notices"
import {
  githubCommitUrl,
  githubPathUrl,
  groupOf,
  ITEM_GROUPS,
  ITEM_STATUSES,
  repoOverview,
  type ItemGroup,
  type ItemStatus,
  type OverviewRow,
  type RepoOverview,
} from "@/lib/core/repos/overview"
import { githubSignInOffered } from "@/lib/core/repos/signin"
import { githubSignInSecret } from "@/lib/core/repos/store"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Repository" }

export const dynamic = "force-dynamic"

const KIND: Record<string, string> = {
  skill: "Skill",
  wrapper: "Wrapper",
  flow: "Browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
  service: "Service",
}

const GROUP: Record<ItemGroup, string> = {
  servers: "Servers and APIs",
  services: "Services",
  wrappers: "Wrappers",
  skills: "Skills",
  flows: "Browser flows",
}

const STATUS: Record<ItemStatus, string> = {
  pushed: "Pushed",
  changed: "Changed",
  not_pushed: "Not pushed",
  imported: "Imported",
  excluded: "Excluded",
}

const STATUS_HINT: Record<ItemStatus, string> = {
  pushed: "In the repository and in step",
  changed: "Changed in your vault, not pushed yet",
  not_pushed: "Only in your vault",
  imported: "Added from the repository, at the commit you reviewed",
  excluded: "Kept out of the repository on purpose",
}

/** The add form's id: the checkboxes in the table belong to it. */
const ADD_FORM = "add-selected"

function statusOf(value: string | string[] | undefined): ItemStatus | "all" {
  return typeof value === "string" &&
    (ITEM_STATUSES as readonly string[]).includes(value)
    ? (value as ItemStatus)
    : "all"
}

function Summary({ overview }: { overview: RepoOverview }) {
  const { repo, counts } = overview

  return (
    <section
      aria-label="Summary"
      className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-separator"
      data-testid="repo-summary"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {repo.visibility === "private" ? (
          <Badge variant="secondary">
            <Lock aria-hidden className="size-3" /> Private
          </Badge>
        ) : repo.visibility === "public" ? (
          <Badge variant="warning">
            <Globe aria-hidden className="size-3" /> Public
          </Badge>
        ) : (
          <Badge variant="secondary">Not checked yet: sync to find out</Badge>
        )}
        <span className="text-muted-foreground">
          {repo.visibility === "public"
            ? "Anyone can read what is pushed here."
            : repo.visibility === "private"
              ? "Only the people GitHub lets read it see what is pushed here."
              : "Until GitHub says otherwise, a push here is treated as public."}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {ITEM_STATUSES.map((status) => (
          <Link
            key={status}
            href={`?status=${status}`}
            className="flex flex-col rounded-lg bg-field px-3 py-2 hover:bg-secondary"
          >
            <dt className="text-xs text-muted-foreground">{STATUS[status]}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {counts[status]}
            </dd>
          </Link>
        ))}
      </dl>
    </section>
  )
}

function Filters({
  current,
  overview,
}: {
  current: ItemStatus | "all"
  overview: RepoOverview
}) {
  const choices: Array<ItemStatus | "all"> = ["all", ...ITEM_STATUSES]

  return (
    <nav aria-label="Show" className="flex flex-wrap gap-1.5">
      {choices.map((choice) => (
        <Link
          key={choice}
          href={choice === "all" ? "?" : `?status=${choice}`}
          aria-current={current === choice ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-sm",
            current === choice
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {choice === "all" ? "All" : STATUS[choice]}
          <span className="tabular-nums text-muted-foreground">
            {choice === "all" ? overview.rows.length : overview.counts[choice]}
          </span>
        </Link>
      ))}
    </nav>
  )
}

function StatusBadge({ row }: { row: OverviewRow }) {
  if (row.link?.waiting === "conflict") {
    return <Badge variant="solid-warning">Conflict</Badge>
  }

  if (row.link?.waiting) {
    return (
      <Badge variant="solid-warning">
        {row.status === "imported" ? "Update available" : "Change to review"}
      </Badge>
    )
  }

  if (row.link?.state === "error" || row.link?.state === "missing") {
    return <Badge variant="destructive">Sync failed</Badge>
  }

  return (
    <Badge
      variant={
        row.status === "changed" || row.status === "not_pushed"
          ? "warning"
          : "secondary"
      }
    >
      {STATUS[row.status]}
    </Badge>
  )
}

function Row({ row, overview }: { row: OverviewRow; overview: RepoOverview }) {
  const { repo } = overview
  const writable = repo.access === "write"
  const choosable =
    writable &&
    !row.linkedElsewhere &&
    (row.status === "not_pushed" || row.status === "changed")
  const item = `${row.kind}:${row.id}`
  const shareHref = `/settings/repositories/${repo.id}/share?item=${encodeURIComponent(item)}`

  return (
    <tr className="border-t border-separator align-top" data-testid="repo-row">
      <td className="w-10 py-3 pl-4">
        {choosable ? (
          <Checkbox
            name="item"
            value={item}
            form={ADD_FORM}
            aria-label={`Choose ${row.displayName}`}
          />
        ) : null}
      </td>
      <td className="py-3 pr-3">
        <div className="flex min-w-40 flex-col gap-0.5">
          <Link
            href={row.href}
            className="text-[15px] break-all hover:underline"
          >
            {row.displayName}
          </Link>
          <span className="text-xs text-muted-foreground">
            {KIND[row.kind]} · <code className="break-all">{row.path}</code>
          </span>
          {row.linkedElsewhere ? (
            <span className="text-xs text-muted-foreground">
              Linked to {row.linkedElsewhere}
            </span>
          ) : null}
          {row.link?.note ? (
            <span className="text-xs break-words text-destructive">
              {row.link.note}
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-3 pr-3">
        <StatusBadge row={row} />
      </td>
      <td className="py-3 pr-3 text-xs text-muted-foreground">
        {row.link ? (
          <div className="flex flex-col gap-0.5">
            {row.link.commit ? (
              <a
                href={githubCommitUrl(repo, row.link.commit)}
                className="font-mono text-primary hover:underline"
                rel="noreferrer"
                target="_blank"
              >
                {row.link.commit.slice(0, 7)}
              </a>
            ) : null}
            <RelativeDate value={row.link.lastSyncAt} />
          </div>
        ) : (
          "—"
        )}
      </td>
      <td className="py-3 pr-4">
        <div className="flex flex-wrap items-center justify-end gap-1">
          {row.link?.waiting ? (
            <ButtonLink
              href={repoChangeHref(row.link.id)}
              variant="ghost"
              size="sm"
            >
              {row.status === "imported" ? "Review update" : "Review"}
            </ButtonLink>
          ) : null}
          {writable && row.status === "changed" && !row.link?.waiting ? (
            <ButtonLink href={shareHref} variant="ghost" size="sm">
              Diff and push
            </ButtonLink>
          ) : null}
          {writable && row.status === "not_pushed" && !row.linkedElsewhere ? (
            <ButtonLink href={shareHref} variant="ghost" size="sm">
              Add
            </ButtonLink>
          ) : null}
          {row.link ? (
            <a
              href={githubPathUrl(repo, row.path, row.kind)}
              className="inline-flex h-8 items-center px-2 text-sm text-muted-foreground hover:underline"
              rel="noreferrer"
              target="_blank"
            >
              View in repo
            </a>
          ) : null}
          {row.status === "not_pushed" || row.status === "excluded" ? (
            <ExcludeButton
              repoId={repo.id}
              item={item}
              excluded={row.status === "excluded"}
              label={row.displayName}
            />
          ) : null}
        </div>
      </td>
    </tr>
  )
}

function ItemsTable({
  overview,
  status,
}: {
  overview: RepoOverview
  status: ItemStatus | "all"
}) {
  const rows = overview.rows.filter(
    (row) => status === "all" || row.status === status,
  )

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {status === "all"
          ? "Nothing here yet. Add items from the repository, or push yours to it."
          : `Nothing is ${STATUS[status].toLowerCase()}: ${STATUS_HINT[status].toLowerCase()}.`}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl bg-card">
      <table className="w-full min-w-[40rem] text-sm" data-testid="repo-table">
        <thead className="sr-only">
          <tr>
            <th>Choose</th>
            <th>Item</th>
            <th>Status</th>
            <th>Last commit</th>
            <th>Actions</th>
          </tr>
        </thead>
        {ITEM_GROUPS.map((group) => {
          const inGroup = rows.filter((row) => groupOf(row.kind) === group)

          return inGroup.length === 0 ? null : (
            <tbody key={group} aria-label={GROUP[group]}>
              <tr>
                <th
                  colSpan={5}
                  scope="colgroup"
                  className="px-4 pt-4 pb-1 text-left text-[13px] font-semibold text-muted-foreground"
                >
                  {GROUP[group]}
                </th>
              </tr>
              {inGroup.map((row) => (
                <Row
                  key={`${row.kind}:${row.id}`}
                  row={row}
                  overview={overview}
                />
              ))}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}

/**
 * One linked repository: a summary (public or private, how many items
 * stand where), what waits for the owner, every shareable item of the vault
 * in one table grouped by kind and filtered by where it stands, and the
 * repository's settings. "Add selected" opens the review of each chosen
 * item in turn; nothing is pushed without its own.
 */
export default async function RepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const query = await searchParams
  const status = statusOf(query.status)
  let overview: RepoOverview

  try {
    overview = await repoOverview(ctx, id)
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

  const { repo, rows } = overview
  const [secrets, signedIn] = await Promise.all([
    listSecrets(ctx),
    githubSignInSecret(ctx),
  ])
  const writable = repo.access === "write"
  const waiting = rows.filter((row) => row.link?.waiting)
  const linked = rows.filter((row) => row.link)

  return (
    <PageColumn>
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

      {typeof query.pushed === "string" ? (
        <p className="text-sm text-muted-foreground" role="status">
          Pushed {query.pushed}.
        </p>
      ) : null}

      <Summary overview={overview} />

      {waiting.length > 0 ? (
        <ListSection title="Waiting for you">
          <List as="ul">
            {waiting.map((row) => (
              <ListRow
                as="li"
                key={row.link!.id}
                href={repoChangeHref(row.link!.id)}
                title={row.displayName}
                description={
                  row.link!.waiting === "conflict"
                    ? "Both changed: keep yours, take theirs, or let an assistant help"
                    : row.status === "imported"
                      ? "An update is available: read it before you take it"
                      : "A change to read and approve"
                }
                trailing={
                  <Badge variant="solid-warning">
                    {row.link!.waiting === "conflict"
                      ? "Conflict"
                      : row.status === "imported"
                        ? "Update available"
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
            of your assistants (prompt injection). What you added stays at the
            commit you reviewed: a newer one shows as an update available, and
            nothing changes until you read and take it.
          </span>
        </p>
      ) : null}

      <ListSection
        title="Items"
        description={
          writable
            ? "Everything you can share, grouped by kind. Choose what to push: each opens its own review before anything goes."
            : "What you added from it, grouped by kind."
        }
        action={<Filters current={status} overview={overview} />}
      >
        <ItemsTable overview={overview} status={status} />
        {writable ? (
          <form
            id={ADD_FORM}
            method="get"
            action={`/settings/repositories/${id}/share`}
            className="flex flex-wrap items-center justify-end gap-2 pt-2"
          >
            <span className="text-xs text-muted-foreground">
              Each chosen item is reviewed on its own, one after another.
            </span>
            <Button type="submit" variant="secondary">
              Add selected
            </Button>
          </form>
        ) : null}
        {overview.skipped.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Left out:{" "}
            {overview.skipped
              .map((entry) => `${entry.name} (${entry.message})`)
              .join("; ")}
          </p>
        ) : null}
        <div className="pt-1">
          <SyncRepoButton repoId={id} />
        </div>
      </ListSection>

      {linked.length > 0 ? (
        <List>
          <Disclosure
            inList
            title="How each item syncs"
            description="How often, two-way or not, Sync now and Unlink"
          >
            <ul className="flex flex-col gap-6 py-2">
              {linked.map((row) => (
                <li key={row.link!.id} className="flex flex-col gap-2">
                  <span className="text-[15px]">{row.displayName}</span>
                  <ItemSyncForm
                    itemId={row.link!.id}
                    label={row.displayName}
                    frequency={row.link!.frequency}
                    bidirectional={row.link!.bidirectional}
                    writable={writable}
                  />
                </li>
              ))}
            </ul>
          </Disclosure>
        </List>
      ) : null}

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
