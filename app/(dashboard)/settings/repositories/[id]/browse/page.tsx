import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/input"
import { List } from "@/components/ui/list"
import { isPcpError } from "@/lib/core/errors"
import { findLocalItem } from "@/lib/core/repos/local"
import {
  browseItems,
  listRemote,
  type BrowsedItem,
} from "@/lib/core/repos/remote"
import { clientFor, getRepo } from "@/lib/core/repos/store"
import type { RepoProblem } from "@/lib/core/repos/layout"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add from a repository" }

export const dynamic = "force-dynamic"

const KIND: Record<string, string> = {
  skill: "Skill",
  wrapper: "Wrapper",
  flow: "Browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
}

/**
 * A linked repository's items as its branch has them now, each with what is
 * wrong with it, for the owner to choose some or all. Choosing opens the
 * next page, which shows every chosen item in full before anything is added.
 */
export default async function BrowsePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const back = { href: `/settings/repositories/${id}`, label: "Repository" }
  let commit = ""
  let items: Array<BrowsedItem & { inVault: boolean }> = []
  let problems: RepoProblem[] = []
  let failure: string | null = null
  let title = "Add from a repository"

  try {
    const repo = await getRepo(ctx, id)
    title = `Add from ${repo.owner}/${repo.name}`
    const gh = await clientFor(ctx, repo)
    const listing = await listRemote(gh, repo, repo.branch)
    commit = listing.head.commit
    problems = listing.problems
    items = await Promise.all(
      (await browseItems(gh, repo, listing)).map(async (item) => ({
        ...item,
        inVault: (await findLocalItem(ctx, item.ref)) !== null,
      })),
    )
  } catch (error) {
    if (!isPcpError(error)) {
      throw error
    }

    failure = error.message
  }

  const readable = items.filter((item) => item.fetched)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={back}
        title={title}
        description="Choose what to add. The next page shows every file of each in full, and what in it reaches further than text; nothing is added until you confirm there."
      />

      {failure ? (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      ) : (
        <form
          method="get"
          action={`/settings/repositories/${id}/add`}
          className="flex flex-col gap-4"
          aria-label="Items in the repository"
        >
          <input type="hidden" name="commit" value={commit} />
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The repository has no item PCP reads: skills/, wrappers/, flows/,
              endpoints/ and servers/, or any folder with a SKILL.md.
            </p>
          ) : (
            <List as="ul">
              {items.map((item) => (
                <li
                  key={item.root}
                  data-slot="list-row"
                  className="flex min-h-14 items-start gap-3.5 px-4 py-3 text-sm"
                >
                  <Checkbox
                    id={`item-${item.root}`}
                    name="item"
                    value={item.root}
                    disabled={!item.fetched}
                    className="mt-1"
                  />
                  <label
                    htmlFor={`item-${item.root}`}
                    className="flex min-w-0 flex-1 flex-col gap-0.5"
                  >
                    <span className="flex flex-wrap items-center gap-2 text-[15px]">
                      {item.ref.name}
                      <Badge variant="secondary">{KIND[item.ref.kind]}</Badge>
                      {item.inVault ? (
                        <Badge variant="secondary">
                          In your vault: updates it
                        </Badge>
                      ) : null}
                    </span>
                    <code className="text-xs break-all text-muted-foreground">
                      {item.root}
                    </code>
                    {item.problem ? (
                      <span className="text-xs text-destructive">
                        {item.problem}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </List>
          )}
          {problems.length > 0 ? (
            <section
              className="flex flex-col gap-1 text-sm"
              aria-label="What PCP could not read"
            >
              <h2 className="text-[13px] font-semibold text-muted-foreground">
                What PCP could not read
              </h2>
              {problems.map((problem, index) => (
                <p key={index} className="break-words text-muted-foreground">
                  <code className="text-xs">{problem.path}</code>{" "}
                  {problem.message}
                </p>
              ))}
            </section>
          ) : null}
          {readable.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="submit" variant="secondary" name="all" value="1">
                Review all {readable.length}
              </Button>
              <Button type="submit">Review the chosen</Button>
            </div>
          ) : null}
        </form>
      )}
    </PageColumn>
  )
}
