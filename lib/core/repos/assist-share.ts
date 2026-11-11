import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, PcpError } from "../errors"
import { hiddenCharacter } from "../memories"

import type { ItemKind } from "./layout"
import { MAX_SHARE_MESSAGE_CHARS } from "./limits"
import { repoOverview, type ItemStatus, type OverviewRow } from "./overview"
import { shareReview } from "./share-review"
import { listRepos, type RepoView } from "./store"

/**
 * An assistant proposing that an item of the vault go to a linked
 * repository: added to it, or its changes pushed. Only a token that may
 * manage endpoints, only an item it sees, only a repository PCP pushes to,
 * and one item at a time. Through the memory tool, as the rest of
 * /repos/ is:
 *
 * - view /repos/share lists the repositories PCP pushes to;
 * - view /repos/share/<owner>/<name> lists the items it sees there, each
 *   Pushed, Changed, Not pushed or Excluded;
 * - create /repos/share/<owner>/<name>/<item's path> proposes that one,
 *   with file_text as a line for the owner on why.
 *
 * The proposal writes nothing and pushes nothing. It is a `repo_share`
 * request whose page sends the owner to the push's review
 * (share-review.ts), the same one every push goes through: every file in
 * full, what stays private, and the personal-data check, which a public
 * repository waits on. Confirm there pushes exactly what it shows
 * (permissions.ts confirmProposedShare), naming the token in the commit.
 */

export const SHARE_ROOT = "/repos/share"

/** What the token sees: the servers and skills an item may be. */
export type ShareScope = {
  ctx: VaultContext
  /** The servers the token reaches, with their definitions. */
  servers: Array<{ id: string; definitionId: string | null }>
  /** null: every skill. */
  skillIds: string[] | null
  publicUrl?: string | null
}

export type RepoShareAsk = {
  repoId: string
  /** "owner/name", for the lines. */
  repo: string
  item: { kind: ItemKind; id: string }
  /** Where it goes in the repository. */
  root: string
  /** The assistant's line for the owner, if it gave one. */
  message: string
  shown: {
    title: string
    lines: string[]
    warning: string | null
    /** What the owner reads and the assistant is not told. */
    ownerOnly: string[]
  }
}

export type ShareOutcome =
  | { text: string }
  | { ask: { kind: "repo_share"; input: RepoShareAsk }; lead: string }

const NOUN: Record<ItemKind, string> = {
  skill: "skill",
  wrapper: "wrapper",
  flow: "browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
  service: "service",
}

const STATUS: Record<ItemStatus, string> = {
  pushed: "Pushed: the same as the vault's",
  changed: "Changed in the vault since it was pushed",
  not_pushed: "Not pushed",
  imported: "Imported",
  excluded: "Excluded by the owner",
}

export function isSharePath(path: string | undefined): boolean {
  return path === SHARE_ROOT || (path?.startsWith(`${SHARE_ROOT}/`) ?? false)
}

/** The repositories PCP pushes to, by "owner/name". */
async function writable(ctx: VaultContext): Promise<RepoView[]> {
  return (await listRepos(ctx)).filter((repo) => repo.access === "write")
}

function label(repo: Pick<RepoView, "owner" | "name">): string {
  return `${repo.owner}/${repo.name}`
}

/** The items of a repository's page that this token sees. */
async function visibleRows(
  scope: ShareScope,
  repo: RepoView,
): Promise<OverviewRow[]> {
  const { rows } = await repoOverview(scope.ctx, repo.id)
  const serverIds = rows
    .filter((row) => row.kind !== "skill")
    .map((row) => row.id)
  const definitions = new Map(
    (
      await db().mcpServer.findMany({
        where: { id: { in: serverIds }, vaultId: scope.ctx.vaultId },
        select: { id: true, definitionId: true },
      })
    ).map((row) => [row.id, row.definitionId]),
  )
  const seenIds = new Set(scope.servers.map((server) => server.id))
  const seenDefinitions = new Set(
    scope.servers.flatMap((server) =>
      server.definitionId ? [server.definitionId] : [],
    ),
  )

  return rows.filter((row) => {
    if (row.status === "imported") {
      return false
    }

    if (row.kind === "skill") {
      return scope.skillIds === null || scope.skillIds.includes(row.id)
    }

    const definitionId = definitions.get(row.id) ?? null

    return (
      seenIds.has(row.id) ||
      (definitionId !== null && seenDefinitions.has(definitionId))
    )
  })
}

function parse(path: string): {
  repo: string | null
  item: string | null
} {
  const rest = path
    .slice(SHARE_ROOT.length)
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)

  return {
    repo: rest.length >= 2 ? `${rest[0]}/${rest[1]}` : null,
    item: rest.length > 2 ? rest.slice(2).join("/") : null,
  }
}

async function findRepo(ctx: VaultContext, named: string): Promise<RepoView> {
  const repos = await writable(ctx)
  const found = repos.find(
    (repo) => label(repo).toLowerCase() === named.toLowerCase(),
  )

  if (!found) {
    const all = await listRepos(ctx)
    const readOnly = all.find(
      (repo) => label(repo).toLowerCase() === named.toLowerCase(),
    )

    throw invalid(
      readOnly
        ? `${label(readOnly)} is read-only in PCP: nothing is pushed to it.`
        : `No linked repository PCP pushes to called ${named}. View ${SHARE_ROOT} to list them.`,
    )
  }

  return found
}

function checkMessage(input: string | undefined): string {
  const text = (input ?? "").replace(/\r\n?/g, "\n").trim()

  if (text.length > MAX_SHARE_MESSAGE_CHARS) {
    throw invalid(
      `Keep file_text, your line for the owner, to ${MAX_SHARE_MESSAGE_CHARS} characters.`,
    )
  }

  const hidden = hiddenCharacter(text)

  if (hidden) {
    throw invalid(
      `file_text has a character that does not show on screen (${hidden}).`,
    )
  }

  return text
}

/** A command on /repos/share…: listings, and create proposing one item. */
export async function runShareCommand(
  scope: ShareScope,
  args: { command: string; path?: string; file_text?: string },
): Promise<ShareOutcome> {
  const { repo: named, item } = parse(args.path ?? SHARE_ROOT)

  if (args.command === "view" && named === null) {
    const repos = await writable(scope.ctx)

    return {
      text: [
        `${SHARE_ROOT}: linked repositories PCP pushes to (${repos.length})`,
        ...(repos.length
          ? repos.map(
              (repo) =>
                `  ${SHARE_ROOT}/${label(repo)} — ${repo.visibility === "private" ? "private" : "anyone can read it"}, branch ${repo.branch}`,
            )
          : ["  (none)"]),
        `View one to list the items you see there. To propose adding one, or pushing its changes, create ${SHARE_ROOT}/<owner>/<name>/<item's path> with file_text as a line for the owner on why; the owner reviews every file and confirms the push.`,
      ].join("\n"),
    }
  }

  if (named === null) {
    throw invalid(
      `Name a repository and an item: ${SHARE_ROOT}/<owner>/<name>/<item's path>, as view lists them.`,
    )
  }

  const repo = await findRepo(scope.ctx, named)
  const rows = await visibleRows(scope, repo)

  if (args.command === "view" && item === null) {
    return {
      text: [
        `${SHARE_ROOT}/${label(repo)}: the items you see, and where each stands with it`,
        ...(rows.length
          ? rows.map(
              (row) =>
                `  ${SHARE_ROOT}/${label(repo)}/${row.path} — ${STATUS[row.status]} (the ${NOUN[row.kind]} ${row.displayName})`,
            )
          : ["  (none)"]),
      ].join("\n"),
    }
  }

  if (args.command !== "create" || item === null) {
    throw invalid(
      `${SHARE_ROOT}/ takes view, and create with an item's path to propose pushing it.`,
    )
  }

  const row = rows.find(
    (entry) => entry.path === item || entry.path === `${item}.yaml`,
  )

  if (!row) {
    throw invalid(
      `No item at ${item} that you see. View ${SHARE_ROOT}/${label(repo)} to list them.`,
    )
  }

  const message = checkMessage(args.file_text)
  const review = await shareReview(
    scope.ctx,
    repo.id,
    { kind: row.kind, id: row.id },
    { publicUrl: scope.publicUrl ?? null },
  )

  if (review.blocked) {
    throw new PcpError("state", review.blocked)
  }

  if (review.state === "same") {
    throw new PcpError(
      "state",
      `${review.root} in ${label(repo)} is the same as the vault's already: there is nothing to push.`,
    )
  }

  const changed = review.files.filter((file) => file.change !== "same")
  const hits = review.hits.length

  return {
    ask: {
      kind: "repo_share",
      input: {
        repoId: repo.id,
        repo: label(repo),
        item: { kind: row.kind, id: row.id },
        root: review.root,
        message,
        shown: {
          title: `Push ${review.item.displayName} to ${label(repo)}?`,
          lines: [
            `Repository: ${label(repo)} (${repo.branch}), ${review.public ? "public: anyone can read it" : "private"}`,
            `Item: the ${NOUN[row.kind]} ${review.item.displayName}, to ${review.root}`,
            review.state === "new"
              ? `New in the repository: ${changed.length} file${changed.length === 1 ? "" : "s"}`
              : `Changes what the repository has: ${changed.length} file${changed.length === 1 ? "" : "s"}`,
            ...(row.status === "excluded"
              ? [
                  "You excluded it from this repository; pushing it includes it again",
                ]
              : []),
            ...(message ? [`The assistant says:\n${message}`] : []),
            "Nothing is pushed from here: the push's review shows every file in full, what stays private and what looks personal, and Confirm there pushes exactly that",
          ],
          warning: review.public
            ? "Anyone can read this repository, and what is pushed stays in its history even if it is taken out later."
            : null,
          ownerOnly:
            hits > 0
              ? [
                  `What looks personal: ${hits} thing${hits === 1 ? "" : "s"}${review.public ? ", each fixed or ticked on the review before it can be pushed" : ""}`,
                ]
              : [],
        },
      },
    },
    lead: "Proposing a push asks the owner: they review every file and confirm it themselves.",
  }
}

/** The owner's page for the push's review of a proposal. */
export function shareReviewHref(ask: RepoShareAsk, requestId: string): string {
  const query = new URLSearchParams({
    item: `${ask.item.kind}:${ask.item.id}`,
    request: requestId,
  })

  return `/settings/repositories/${encodeURIComponent(ask.repoId)}/share?${query}`
}
